import { registerDevice } from './push';
import { KEYS, get, set, remove } from './store';
import { RESULT, getJson, post } from './transport';
import type { ChatOptions } from './types';
import type { ChatLocale } from './chat-strings';
import type {
  ChatConversation,
  ChatLead,
  ChatMessage,
  ChatMessagePayload,
  ChatState,
  ChatWidgetConfig,
  SendExtra,
} from './chat-types';

/**
 * The website chat widget's engine: what the organization configured, the
 * visitor's conversation, sending, and the live stream of what the team and
 * its scenarios write back. Nothing here touches the DOM; `chat-view.ts`
 * draws it.
 *
 * The visitor is the browser's registered device, the same one in-app uses:
 * the first message registers it when nothing else has (no prompt, no
 * permission), and every call that touches the conversation carries the
 * device's proof of possession. A page view costs one small config fetch,
 * cached for a few minutes.
 */

const MS_PER_SECOND = 1000;
const CONFIG_TTL_MS = 5 * 60 * MS_PER_SECOND;
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
const DEVICE_AUTH_HEADER = 'X-Arsel-Device-Auth';
/** The server refuses a conversation the organization has no allowance left for. */
const HTTP_CONFLICT = 409;
const SECONDS_ON_PAGE_MAX = 24 * 60 * 60;
/** A bot's line is revealed after a pause that reads as typing: this long, plus a little per character. */
const TYPING_BASE_MS = 500;
const TYPING_PER_CHARACTER_MS = 12;
const TYPING_MAX_MS = 1800;
/** Only a line that just arrived is paced; history and catch-up after a long gap show at once. */
const PACED_LINE_MAX_AGE_MS = 30 * MS_PER_SECOND;

interface CachedConfig {
  fetchedAtMs: number;
  /** Null when the organization shows no widget. */
  config: ChatWidgetConfig | null;
}

interface SessionResponse {
  online: boolean;
  conversation: ChatConversation | null;
  messages: ChatMessage[];
}

interface SendResponse {
  sent: ChatMessage;
  conversation: ChatConversation;
  online: boolean;
  reply: ChatMessage | null;
}

interface StreamFrame {
  event: string;
  data: unknown;
}

type Listener = (state: ChatState) => void;

let state: ChatState = emptyState();
let options: Required<ChatOptions> | null = null;
let debug = false;
let started = false;
let starting: Promise<void> | null = null;
let openedAtMs = 0;
const listeners = new Set<Listener>();
let stream: EventSource | null = null;
let streamLive = false;
let streamFailures = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let burstTimer: ReturnType<typeof setTimeout> | null = null;
let burstTicksLeft = 0;
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let lastRevealAtMs = 0;
let renderer: ((state: ChatState) => void) | null = null;

function emptyState(): ChatState {
  return {
    config: null,
    conversation: null,
    messages: [],
    online: false,
    unread: 0,
    isOpen: false,
    identified: false,
    overQuota: false,
  };
}

function log(message: string): void {
  if (debug) console.info(`[arsel] chat: ${message}`);
}

function publish(change: Partial<ChatState>): void {
  state = { ...state, ...change };
  renderer?.(state);
  for (const listener of listeners) listener(state);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** The DOM layer registers itself here; `index.ts` wires it at init. */
export function setRenderer(fn: (state: ChatState) => void): void {
  renderer = fn;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function snapshot(): ChatState {
  return state;
}

/**
 * Loads the widget, from the cache or the server, and draws the launcher
 * when the organization shows one. A 404 is the ordinary case for an
 * organization without the widget and is remembered for a while.
 */
export function start(
  chatOptions: Required<ChatOptions>,
  debugEnabled: boolean,
): Promise<void> {
  options = chatOptions;
  debug = debugEnabled;
  started = true;
  openedAtMs = Date.now();
  starting = load().finally(() => {
    starting = null;
  });
  return starting;
}

async function load(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    log('no widget for this organization');
    return;
  }
  const identified = Boolean(
    (await get<string>(KEYS.email)) || (await get<string>(KEYS.phoneNumber)),
  );
  publish({ config, online: config.online, identified });
  // A browser that already wrote once has a conversation to show and to listen on.
  if (await get<string>(KEYS.deviceSecret)) {
    await refreshSession();
    if (state.conversation) connectStream();
  }
}

/** The visitor opened the window: show the thread, mark it read. Waits for a start still loading. */
export async function open(): Promise<void> {
  if (starting) await starting.catch(() => undefined);
  if (!state.config) return;
  publish({ isOpen: true, unread: 0 });
  if (!state.conversation && (await get<string>(KEYS.deviceSecret))) {
    await refreshSession();
    if (state.conversation) connectStream();
  }
}

export function close(): void {
  if (!state.config) return;
  publish({ isOpen: false });
}

/** Logout: the next person on this browser starts with an empty thread. */
export async function onReset(): Promise<void> {
  disconnectStream();
  await remove(KEYS.chatConfig);
  const config = state.config;
  state = emptyState();
  if (config) publish({ config, online: config.online });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends the visitor's line: typed, or the quick reply or welcome button
 * they tapped. It appears at once as pending, then as the server stored it;
 * a failure leaves it marked so the visitor can retry with the same id,
 * which the server takes once. When the organization is out of
 * conversations the line is dropped, the outside-hours notice shows and the
 * form takes the lead instead.
 */
export async function send(text: string, extra: SendExtra = {}): Promise<boolean> {
  const body = text.trim();
  if (!state.config || !body) return false;
  const clientMessageId = extra.retryOf ?? crypto.randomUUID();
  const tapped: ChatMessagePayload | null =
    extra.option || extra.replyTo
      ? {
          ...(extra.option ? { option: extra.option } : {}),
          ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
        }
      : null;
  const pending: ChatMessage = {
    id: `pending:${clientMessageId}`,
    direction: 'in',
    at: new Date().toISOString(),
    kind: 'text',
    text: body,
    sender: { kind: 'visitor', name: null },
    payload: tapped,
    pending: 'sending',
    clientMessageId,
  };
  publish({ messages: [...withoutClientId(state.messages, clientMessageId), pending] });

  const device = await ensureDevice();
  if (!device) return fail(clientMessageId);
  const response = await post<SendResponse>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/messages`,
    {
      installationId: device.installationId,
      clientMessageId,
      text: body,
      ...(extra.option ? { option: extra.option } : {}),
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      locale: readLocale(),
      page: readPage(),
      secondsOnPage: secondsOnPage(),
    },
    { [DEVICE_AUTH_HEADER]: device.deviceSecret },
    true,
  );
  if (response.code === HTTP_CONFLICT) return overQuota(clientMessageId);
  if (response.result !== RESULT.success || !response.body) {
    log(`send failed with ${response.code}`);
    return fail(clientMessageId);
  }
  const { sent, conversation, online, reply } = response.body;
  const hadConversation = state.conversation !== null;
  publish({
    conversation,
    online,
    messages: mergeLines(withoutClientId(state.messages, clientMessageId), [
      // The tap stays on the line even where the server echoes none.
      { ...sent, clientMessageId, payload: sent.payload ?? tapped },
      ...(reply ? [paced(reply)] : []),
    ]),
  });
  if (!hadConversation) connectStream();
  startBurst();
  return true;
}

/**
 * The visitor filled the form: the offline or lead form the widget shows
 * on its own, or the one a scenario asked for, named by `requestId`.
 */
export async function submitLead(lead: ChatLead, requestId?: string): Promise<boolean> {
  const device = await ensureDevice();
  if (!device) return false;
  const response = await post<{ identified: boolean }>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/leads`,
    { installationId: device.installationId, ...lead, ...(requestId ? { requestId } : {}) },
    { [DEVICE_AUTH_HEADER]: device.deviceSecret },
    true,
  );
  if (response.result !== RESULT.success) return false;
  if (lead.email) await set(KEYS.email, lead.email);
  if (lead.phone) await set(KEYS.phoneNumber, lead.phone);
  publish({ identified: true });
  if (requestId) startBurst();
  return true;
}

/** The visitor skipped the form a scenario asked for: the scenario moves on. */
export async function skipForm(requestId: string): Promise<boolean> {
  const device = await readDevice();
  if (!device) return false;
  const response = await post(
    device.baseUrl,
    `${chatPath(device.clientKey)}/leads`,
    { installationId: device.installationId, requestId, skipped: true, consent: false },
    { [DEVICE_AUTH_HEADER]: device.deviceSecret },
    true,
  );
  if (response.result !== RESULT.success) return false;
  startBurst();
  return true;
}

function fail(clientMessageId: string): boolean {
  publish({
    messages: state.messages.map((m) =>
      m.clientMessageId === clientMessageId ? { ...m, pending: 'failed' } : m,
    ),
  });
  return false;
}

/**
 * No conversation can open: the line goes, the outside-hours notice shows
 * once, and the team is drawn as away so the form asks for an address the
 * team can answer later.
 */
function overQuota(clientMessageId: string): boolean {
  log('the organization is out of conversations');
  const config = state.config;
  const notice: ChatMessage = {
    id: 'local:over-quota',
    direction: 'out',
    at: new Date().toISOString(),
    kind: 'notice',
    text: config ? config.texts[resolveLocale(config)].outsideHours : null,
    sender: { kind: 'system', name: null },
  };
  publish({
    online: false,
    overQuota: true,
    messages: mergeLines(withoutClientId(state.messages, clientMessageId), [notice]),
  });
  return false;
}

// ---------------------------------------------------------------------------
// The conversation and its stream
// ---------------------------------------------------------------------------

async function refreshSession(): Promise<void> {
  const device = await readDevice();
  if (!device) return;
  const response = await post<SessionResponse>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/sessions`,
    { installationId: device.installationId, locale: readLocale(), page: readPage() },
    { [DEVICE_AUTH_HEADER]: device.deviceSecret },
    true,
  );
  if (response.result !== RESULT.success || !response.body) return;
  const { online, conversation, messages } = response.body;
  publish({ online, conversation, messages: mergeLines(messages, pendingLines()) });
}

function connectStream(): void {
  if (stream || !state.conversation) return;
  if (typeof EventSource === 'undefined') {
    startPolling();
    return;
  }
  void openStream().catch((error) => {
    log(`stream failed: ${error instanceof Error ? error.message : ''}`);
    scheduleReconnect();
  });
}

async function openStream(): Promise<void> {
  const device = await readDevice();
  if (!device || !state.conversation) return;
  const ticket = await post<{ ticket: string }>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/stream-ticket`,
    { installationId: device.installationId },
    { [DEVICE_AUTH_HEADER]: device.deviceSecret },
    true,
  );
  if (ticket.result !== RESULT.success || !ticket.body?.ticket) {
    scheduleReconnect();
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
    streamFailures += 1;
    scheduleReconnect();
  };
}

function handleFrame(frame: StreamFrame): void {
  switch (frame.event) {
    case 'message':
      receive(frame.data as ChatMessage);
      return;
    case 'conversation':
      publish({ conversation: frame.data as ChatConversation });
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

/** A line from the stream or a poll: shown once, counted unread while the window is closed. */
function receive(message: ChatMessage): void {
  if (state.messages.some((m) => m.id === message.id)) return;
  const fromTeam = message.direction === 'out';
  publish({
    messages: mergeLines(state.messages, [paced(message)]),
    unread: state.unread + (fromTeam && !state.isOpen ? 1 : 0),
  });
}

async function catchUp(): Promise<void> {
  const device = await readDevice();
  if (!device || !state.conversation) return;
  const last = [...state.messages].reverse().find((m) => !m.pending && !isLocal(m));
  const query = new URLSearchParams({
    installationId: device.installationId,
    limit: String(CATCH_UP_LIMIT),
    ...(last ? { after: last.id } : {}),
  });
  const response = await getJson<{ data: ChatMessage[] }>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/messages?${query.toString()}`,
    { [DEVICE_AUTH_HEADER]: device.deviceSecret },
    true,
  );
  if (response.result !== RESULT.success || !response.body) return;
  for (const line of response.body.data) receive(line);
}

function scheduleReconnect(): void {
  if (reconnectTimer || !started) return;
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
function startBurst(): void {
  burstTicksLeft = BURST_TICKS;
  if (burstTimer) return;
  burstTimer = setTimeout(burstTick, BURST_INTERVAL_MS);
}

function burstTick(): void {
  burstTimer = null;
  if (!started || !state.conversation) return;
  burstTicksLeft -= 1;
  if (!streamLive) void catchUp();
  if (burstTicksLeft > 0) burstTimer = setTimeout(burstTick, BURST_INTERVAL_MS);
}

function stopBurst(): void {
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = null;
  burstTicksLeft = 0;
}

function disconnectStream(): void {
  stream?.close();
  stream = null;
  streamLive = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopPolling();
  stopBurst();
}

/** For tests and `pagehide`: nothing stays open. */
export function stop(): void {
  disconnectStream();
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  started = false;
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/**
 * A bot's line that just arrived is revealed after a pause that reads as
 * typing, one line after another; the view draws the dots meanwhile. A
 * teammate's line, a notice and anything older show at once.
 */
function paced(message: ChatMessage): ChatMessage {
  if (message.direction !== 'out' || message.sender.kind !== 'bot') return message;
  if (message.kind === 'notice') return message;
  const now = Date.now();
  const arrivedAt = Date.parse(message.at);
  if (Number.isFinite(arrivedAt) && now - arrivedAt > PACED_LINE_MAX_AGE_MS) return message;
  const typingMs = Math.min(
    TYPING_BASE_MS + (message.text?.length ?? 0) * TYPING_PER_CHARACTER_MS,
    TYPING_MAX_MS,
  );
  const revealAt = Math.max(now, lastRevealAtMs) + typingMs;
  lastRevealAtMs = revealAt;
  scheduleReveal(revealAt);
  return { ...message, revealAt };
}

/** Redraws when the next hidden line is due; one timer, for the earliest reveal. */
function scheduleReveal(revealAt: number): void {
  const due = state.messages
    .map((m) => m.revealAt ?? 0)
    .filter((at) => at > Date.now())
    .concat(revealAt);
  const next = Math.min(...due);
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(
    () => {
      revealTimer = null;
      publish({});
      const pending = state.messages.some((m) => (m.revealAt ?? 0) > Date.now());
      if (pending) scheduleReveal(Infinity);
    },
    Math.max(0, next - Date.now()),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Device {
  clientKey: string;
  baseUrl: string;
  installationId: string;
  deviceSecret: string;
}

async function readDevice(): Promise<Device | null> {
  const [clientKey, baseUrl, installationId, deviceSecret] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
    get<string>(KEYS.installationId),
    get<string>(KEYS.deviceSecret),
  ]);
  if (!clientKey || !baseUrl || !installationId || !deviceSecret) return null;
  return { clientKey, baseUrl, installationId, deviceSecret };
}

/** Registers the browser on first use, when in-app has not done it: the moment the visitor writes. */
async function ensureDevice(): Promise<Device | null> {
  const existing = await readDevice();
  if (existing) return existing;
  if (!(await registerDevice())) return null;
  return readDevice();
}

async function loadConfig(): Promise<ChatWidgetConfig | null> {
  const cached = await get<CachedConfig>(KEYS.chatConfig);
  if (cached && Date.now() - cached.fetchedAtMs < CONFIG_TTL_MS) return cached.config;
  const [clientKey, baseUrl] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
  ]);
  if (!clientKey || !baseUrl) return null;
  const response = await getJson<ChatWidgetConfig>(
    baseUrl,
    `${chatPath(clientKey)}/config`,
  );
  if (response.code === 404) {
    await set(KEYS.chatConfig, { fetchedAtMs: Date.now(), config: null });
    return null;
  }
  if (response.result !== RESULT.success || !response.body) {
    // Offline or throttled: whatever was shown last keeps being shown.
    return cached?.config ?? null;
  }
  await set(KEYS.chatConfig, { fetchedAtMs: Date.now(), config: response.body });
  return response.body;
}

function chatPath(clientKey: string): string {
  return `/api/v1/orgs/${encodeURIComponent(clientKey)}/chat`;
}

/** The visitor's own lines still in flight, kept across a session refresh. */
function pendingLines(): ChatMessage[] {
  return state.messages.filter((m) => m.pending);
}

/** A line the widget wrote itself, which the server never had. */
function isLocal(message: ChatMessage): boolean {
  return message.id.startsWith('local:');
}

function withoutClientId(lines: ChatMessage[], clientMessageId: string): ChatMessage[] {
  return lines.filter((m) => m.clientMessageId !== clientMessageId);
}

/** Lines in order, each once: a pending line gives way to its stored self. */
function mergeLines(base: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const line of incoming) byId.set(line.id, line);
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** How long the visitor has had this page open, whole seconds, capped at a day. */
function secondsOnPage(): number {
  const seconds = Math.floor((Date.now() - openedAtMs) / MS_PER_SECOND);
  return Math.max(0, Math.min(seconds, SECONDS_ON_PAGE_MAX));
}

/** The language the widget runs in: pinned by the organization, else the page's. */
export function resolveLocale(config: ChatWidgetConfig): ChatLocale {
  if (config.language !== 'auto') return config.language;
  return readLocale().toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

function readLocale(): string {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement?.lang;
    if (lang) return lang;
  }
  return typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en';
}

function readPage(): { url?: string; title?: string } {
  if (typeof document === 'undefined') return {};
  const url = typeof location !== 'undefined' ? location.href : undefined;
  const title = document.title || undefined;
  return {
    ...(url && /^https?:/.test(url) ? { url: url.slice(0, 2048) } : {}),
    ...(title ? { title: title.slice(0, 200) } : {}),
  };
}

export function currentOptions(): Required<ChatOptions> | null {
  return options;
}
