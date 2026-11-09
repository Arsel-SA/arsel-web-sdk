import { chatPath, deviceHeaders, readDevice } from './chat-device';
import { paced } from './chat-pacing';
import { current, isLocal, isRunning, log, mergeLines, publish } from './chat-state';
import type { ChatAttachment, ChatConversation, ChatMessage } from './chat-types';
import { RESULT, getJson, post } from './transport';

/**
 * What the team and its scenarios write back, as it happens: a server-sent
 * events stream opened through a single-use ticket, with a catch-up read
 * whenever it opens, polling where it cannot, and a short burst of fetches
 * after each send. Also the team's typing and how far it has read.
 */

const MS_PER_SECOND = 1000;
const STREAM_RECONNECT_BASE_MS = 2 * MS_PER_SECOND;
const STREAM_RECONNECT_MAX_MS = 30 * MS_PER_SECOND;
/** After this many failed stream openings the widget polls instead. */
const STREAM_FAILURES_BEFORE_POLLING = 3;
const POLL_INTERVAL_MS = 10 * MS_PER_SECOND;
/** Right after a send, while the stream may not be up yet, replies are fetched this often… */
const BURST_INTERVAL_MS = 1.5 * MS_PER_SECOND;
/** …this many times, fifteen seconds in all: a scenario's first answer lands within a second or two. */
const BURST_TICKS = 10;
const CATCH_UP_LIMIT = 100;
/** A teammate's typing frame keeps the dots up this long; the server sends one every few seconds. */
const AGENT_TYPING_SHOWN_MS = 6 * MS_PER_SECOND;

interface StreamFrame {
  event: string;
  data: unknown;
}

interface AttachmentUpdate {
  messageId: string | null;
  attachment: ChatAttachment;
}

let stream: EventSource | null = null;
let streamLive = false;
let streamFailures = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let burstTimer: ReturnType<typeof setTimeout> | null = null;
let burstTicksLeft = 0;
let typingTimer: ReturnType<typeof setTimeout> | null = null;

export function connectStream(): void {
  if (stream || !current().conversation) return;
  if (typeof EventSource === 'undefined') {
    startPolling();
    return;
  }
  void openStream().catch((error) => {
    log(`stream failed: ${error instanceof Error ? error.message : ''}`);
    failed();
  });
}

async function openStream(): Promise<void> {
  const device = await readDevice();
  if (!device || !current().conversation) return;
  const ticket = await post<{ ticket: string }>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/stream-ticket`,
    { installationId: device.installationId },
    deviceHeaders(device),
    true,
  );
  if (ticket.result !== RESULT.success || !ticket.body?.ticket) {
    // A refused ticket counts like a dropped stream, or the widget would ask
    // for one every two seconds for as long as the page stays open.
    failed();
    return;
  }
  const url = `${device.baseUrl}${chatPath(device.clientKey)}/stream?ticket=${encodeURIComponent(ticket.body.ticket)}`;
  const source = new EventSource(url);
  stream = source;
  source.onopen = () => {
    streamFailures = 0;
    streamLive = true;
    stopPolling();
    void catchUp();
  };
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      handleFrame(JSON.parse(event.data) as StreamFrame);
    } catch {
      /* a frame the widget cannot read is dropped */
    }
  };
  source.onerror = () => {
    if (stream !== source) return;
    source.close();
    stream = null;
    streamLive = false;
    failed();
  };
}

function failed(): void {
  streamFailures += 1;
  scheduleReconnect();
}

export function handleFrame(frame: StreamFrame): void {
  switch (frame.event) {
    case 'message':
      receive(frame.data as ChatMessage);
      return;
    case 'message_updated':
      receive(frame.data as ChatMessage, true);
      return;
    case 'attachment_updated':
      attachmentUpdated(frame.data as AttachmentUpdate);
      return;
    case 'conversation':
      publish({ conversation: frame.data as ChatConversation });
      return;
    case 'typing':
      agentTyping((frame.data as { agent?: { name: string | null } }).agent ?? null);
      return;
    case 'read':
      agentRead((frame.data as { at?: string }).at ?? null);
      return;
    case 'reconnect':
    case 'auth-error':
      disconnectStream();
      scheduleReconnect();
      return;
    default:
      return;
  }
}

/**
 * A line from the stream or a poll: shown once, counted unread while the
 * window is closed. An update replaces the line it names, and a teammate's
 * line ends their typing.
 */
export function receive(message: ChatMessage, update = false): void {
  const state = current();
  const known = state.messages.some((m) => m.id === message.id);
  if (known && !update) return;
  if (!known && update) return;
  const fromTeam = message.direction === 'out';
  const typing = fromTeam && message.sender.kind === 'agent' ? null : state.agentTyping;
  publish({
    messages: mergeLines(state.messages, [update ? message : paced(message)]),
    unread: state.unread + (fromTeam && !known && !state.isOpen ? 1 : 0),
    agentTyping: typing ?? null,
  });
}

/**
 * A file of the thread changed: the malware scanner cleared it, or removed
 * it as harmful. The line holding it gets the file as it stands now.
 */
function attachmentUpdated(update: AttachmentUpdate): void {
  const { attachment } = update;
  if (!attachment?.id) return;
  const messages = current().messages.map((line) =>
    line.attachments?.some((file) => file.id === attachment.id)
      ? {
          ...line,
          attachments: line.attachments.map((file) => (file.id === attachment.id ? attachment : file)),
        }
      : line,
  );
  publish({ messages });
}

function agentTyping(agent: { name: string | null } | null): void {
  if (!agent) return;
  publish({ agentTyping: { name: agent.name, until: Date.now() + AGENT_TYPING_SHOWN_MS } });
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typingTimer = null;
    const typing = current().agentTyping;
    if (typing && typing.until <= Date.now()) publish({ agentTyping: null });
  }, AGENT_TYPING_SHOWN_MS);
}

function agentRead(at: string | null): void {
  const conversation = current().conversation;
  if (!at || !conversation) return;
  publish({ conversation: { ...conversation, agentReadAt: at } });
}

export async function catchUp(): Promise<void> {
  const device = await readDevice();
  if (!device || !current().conversation) return;
  const last = [...current().messages].reverse().find((m) => !m.pending && !isLocal(m));
  const query = new URLSearchParams({
    installationId: device.installationId,
    limit: String(CATCH_UP_LIMIT),
    ...(last ? { after: last.id } : {}),
  });
  const response = await getJson<{ data: ChatMessage[] }>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/messages?${query.toString()}`,
    deviceHeaders(device),
    true,
  );
  if (response.result !== RESULT.success || !response.body) return;
  for (const line of response.body.data) receive(line);
}

function scheduleReconnect(): void {
  if (reconnectTimer || !isRunning()) return;
  if (streamFailures >= STREAM_FAILURES_BEFORE_POLLING) {
    startPolling();
    return;
  }
  const delay = Math.min(
    STREAM_RECONNECT_BASE_MS * 2 ** streamFailures,
    STREAM_RECONNECT_MAX_MS,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStream();
  }, delay);
}

function startPolling(): void {
  if (pollTimer) return;
  log('polling for replies');
  pollTimer = setInterval(() => void catchUp(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * The seconds after a send, when a scenario answers: without a live stream
 * the widget fetches the thread every second and a half for a while, so
 * the answer does not wait for the next ten-second poll.
 */
export function startBurst(): void {
  burstTicksLeft = BURST_TICKS;
  if (burstTimer) return;
  burstTimer = setTimeout(burstTick, BURST_INTERVAL_MS);
}

function burstTick(): void {
  burstTimer = null;
  if (!isRunning() || !current().conversation) return;
  burstTicksLeft -= 1;
  if (!streamLive) void catchUp();
  if (burstTicksLeft > 0) burstTimer = setTimeout(burstTick, BURST_INTERVAL_MS);
}

function stopBurst(): void {
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = null;
  burstTicksLeft = 0;
}

/** Closes the stream and every timer of it; a later `connectStream()` starts over. */
export function disconnectStream(): void {
  stream?.close();
  stream = null;
  streamLive = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = null;
  stopPolling();
  stopBurst();
}

/** A fresh start for the stream's own counters, as a new page would have. */
export function resetStream(): void {
  disconnectStream();
  streamFailures = 0;
}
