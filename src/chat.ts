import {
  chatPath,
  deviceHeaders,
  ensureDevice,
  readDevice,
  readLocale,
  readPage,
  type Device,
} from './chat-device';
import { freshLink, refusalOf, upload, type FileRefusal } from './chat-files';
import { paced, stopPacing } from './chat-pacing';
import { startProactive, stopProactive } from './chat-proactive';
import { stopReads, watchReads } from './chat-signals';
import {
  current,
  isRunning,
  log,
  mergeLines,
  pendingLines,
  publish,
  resetState,
  setDebug,
  setRunning,
  withoutClientId,
} from './chat-state';
import { connectStream, disconnectStream, resetStream, startBurst } from './chat-stream';
import { KEYS, get, set, remove } from './store';
import { RESULT, getJson, post } from './transport';
import type { ChatOptions } from './types';
import type { ChatLocale } from './chat-strings';
import type {
  ChatAttachment,
  ChatConversation,
  ChatLead,
  ChatMessage,
  ChatMessagePayload,
  ChatProactiveMessage,
  ChatState,
  ChatWidgetConfig,
  SendExtra,
} from './chat-types';

export { setRenderer, subscribe } from './chat-state';
export { noteTyping } from './chat-signals';
export type { FileRefusal } from './chat-files';

/**
 * The website chat widget's engine: what the organization configured, the
 * visitor's conversation, sending lines and files, ratings and proactive
 * messages. Nothing here touches the DOM; `chat-view.ts` draws it. The live
 * stream is `chat-stream.ts`, the visitor's typing and reads
 * `chat-signals.ts`, the proactive messages `chat-proactive.ts`.
 *
 * The visitor is the browser's registered device, the same one in-app uses:
 * the first message registers it when nothing else has (no prompt, no
 * permission), and every call that touches the conversation carries the
 * device's proof of possession. A page view costs one small config fetch,
 * cached for a few minutes.
 */

const MS_PER_SECOND = 1000;
const CONFIG_TTL_MS = 5 * 60 * MS_PER_SECOND;
/** The server refuses a conversation the organization has no allowance left for. */
const HTTP_CONFLICT = 409;
const SECONDS_ON_PAGE_MAX = 24 * 60 * 60;

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

/** A file the visitor chose, kept for a retry, with what the upload gave back once it did. */
interface FileInFlight {
  file: File;
  attachment: ChatAttachment | null;
}

let starting: Promise<void> | null = null;
let openedAtMs = 0;
let pageWatched = false;
/** The proactive message shown, by key, until the visitor's first line answers it. */
let pendingOpener: string | null = null;
const filesInFlight = new Map<string, FileInFlight>();
/** Files whose link was refreshed this page: an image that cannot load asks once, not in a loop. */
const refreshedLinks = new Set<string>();

export function snapshot(): ChatState {
  return current();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Loads the widget, from the cache or the server, and draws the launcher
 * when the organization shows one. A 404 is the ordinary case for an
 * organization without the widget and is remembered for a while.
 */
export function start(_options: Required<ChatOptions>, debugEnabled: boolean): Promise<void> {
  setDebug(debugEnabled);
  setRunning(true);
  openedAtMs = Date.now();
  watchPage();
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
    if (current().conversation) connectStream();
  }
  watchReads();
  startProactive(config, showProactive);
}

/** A closed or hidden-for-good page keeps no stream open; one restored from the back-forward cache picks it up again. */
function watchPage(): void {
  if (pageWatched || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  pageWatched = true;
  window.addEventListener('pagehide', () => disconnectStream());
  window.addEventListener('pageshow', (event) => {
    const restored = (event as PageTransitionEvent).persisted;
    if (restored && isRunning() && current().conversation) connectStream();
  });
}

/** The visitor opened the window: show the thread, mark it read. Waits for a start still loading. */
export async function open(): Promise<void> {
  if (starting) await starting.catch(() => undefined);
  const state = current();
  if (!state.config) return;
  const opener = openerLine();
  publish({
    isOpen: true,
    unread: 0,
    ...(opener ? { messages: mergeLines(state.messages, [opener]) } : {}),
  });
  if (!current().conversation && (await get<string>(KEYS.deviceSecret))) {
    await refreshSession();
    if (current().conversation) connectStream();
  }
}

export function close(): void {
  if (!current().config) return;
  publish({ isOpen: false });
}

/** Logout: the next person on this browser starts with an empty thread. */
export async function onReset(): Promise<void> {
  resetStream();
  stopProactive();
  await remove(KEYS.chatConfig);
  const config = current().config;
  resetState();
  pendingOpener = null;
  filesInFlight.clear();
  if (config) publish({ config, online: config.online });
  watchReads();
}

/** For tests: nothing stays open. */
export function stop(): void {
  disconnectStream();
  stopPacing();
  stopReads();
  stopProactive();
  setRunning(false);
}

// ---------------------------------------------------------------------------
// Proactive messages
// ---------------------------------------------------------------------------

/** A proactive message fired: a teaser above the launcher, or the window opened on it. */
function showProactive(message: ChatProactiveMessage): void {
  const config = current().config;
  if (!config) return;
  pendingOpener = message.key;
  publish({
    proactive: {
      key: message.key,
      text: message.text[resolveLocale(config)],
      display: message.display,
    },
  });
  if (message.display === 'open') void open();
}

/** The visitor closed the teaser: it goes, and their first line answers nothing. */
export function dismissProactive(): void {
  if (!current().proactive) return;
  pendingOpener = null;
  publish({ proactive: null });
}

/** The proactive message the window opened on, as the thread's first line from the team, once. */
function openerLine(): ChatMessage | null {
  const shown = current().proactive;
  if (!shown || pendingOpener !== shown.key) return null;
  const id = openerId(shown.key);
  if (current().messages.some((m) => m.id === id)) return null;
  return {
    id,
    direction: 'out',
    at: new Date().toISOString(),
    kind: 'text',
    text: shown.text,
    sender: { kind: 'system', name: null },
  };
}

const openerId = (key: string): string => `local:proactive:${key}`;

/** What the visitor's next line answers: the proactive message, while no conversation is open. */
function openerToSend(): string | null {
  if (!pendingOpener) return null;
  const conversation = current().conversation;
  return conversation?.status === 'open' ? null : pendingOpener;
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
  if (!current().config || !body) return false;
  const clientMessageId = extra.retryOf ?? crypto.randomUUID();
  const tapped: ChatMessagePayload | null =
    extra.option || extra.replyTo
      ? {
          ...(extra.option ? { option: extra.option } : {}),
          ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
        }
      : null;
  showPending({ clientMessageId, kind: 'text', text: body, payload: tapped });
  const device = await ensureDevice();
  if (!device) return fail(clientMessageId);
  return deliver(device, clientMessageId, {
    text: body,
    ...(extra.option ? { option: extra.option } : {}),
    ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
  }, tapped);
}

/**
 * Sends an image or a PDF the visitor chose: refused at once when it is too
 * big or another type, uploaded, then sent as a line of its own. The answer
 * is why it did not go, or null once it went.
 */
export async function sendFile(file: File, retryOf?: string): Promise<FileRefusal | null> {
  if (!current().config?.allowAttachments) return 'failed';
  const refusal = refusalOf(file);
  if (refusal) return refusal;
  const clientMessageId = retryOf ?? crypto.randomUUID();
  const inFlight = filesInFlight.get(clientMessageId) ?? { file, attachment: null };
  filesInFlight.set(clientMessageId, inFlight);
  showPending({
    clientMessageId,
    kind: 'file',
    text: '',
    attachments: [
      { id: `local:${clientMessageId}`, name: file.name, contentType: file.type, size: file.size, url: null },
    ],
  });
  const device = await ensureDevice();
  if (!device) {
    fail(clientMessageId);
    return 'failed';
  }
  if (!inFlight.attachment) {
    const uploaded = await upload(device, file);
    if ('refusal' in uploaded) {
      fail(clientMessageId);
      return uploaded.refusal;
    }
    inFlight.attachment = uploaded.attachment;
  }
  const attachment = inFlight.attachment;
  const sent = await deliver(device, clientMessageId, { attachmentId: attachment.id }, null, [attachment]);
  if (!sent) return 'failed';
  filesInFlight.delete(clientMessageId);
  return null;
}

/** A failed line again, under its own id: its words, or its file. */
export async function retry(clientMessageId: string): Promise<boolean> {
  const line = current().messages.find((m) => m.clientMessageId === clientMessageId);
  if (!line) return false;
  const inFlight = filesInFlight.get(clientMessageId);
  if (inFlight) return (await sendFile(inFlight.file, clientMessageId)) === null;
  return send(line.text ?? '', {
    retryOf: clientMessageId,
    option: line.payload?.option,
    replyTo: line.payload?.replyTo,
  });
}

function showPending(line: {
  clientMessageId: string;
  kind: 'text' | 'file';
  text: string;
  payload?: ChatMessagePayload | null;
  attachments?: ChatAttachment[];
}): void {
  const pending: ChatMessage = {
    id: `pending:${line.clientMessageId}`,
    direction: 'in',
    at: new Date().toISOString(),
    kind: line.kind,
    text: line.text,
    sender: { kind: 'visitor', name: null },
    payload: line.payload ?? null,
    ...(line.attachments ? { attachments: line.attachments } : {}),
    pending: 'sending',
    clientMessageId: line.clientMessageId,
  };
  publish({
    messages: [...withoutClientId(current().messages, line.clientMessageId), pending],
  });
}

/** The line to the server, and the thread as it stored it. */
async function deliver(
  device: Device,
  clientMessageId: string,
  content: { text?: string; option?: string; replyTo?: string; attachmentId?: string },
  tapped: ChatMessagePayload | null,
  attachments?: ChatAttachment[],
): Promise<boolean> {
  const opener = openerToSend();
  const response = await post<SendResponse>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/messages`,
    {
      installationId: device.installationId,
      clientMessageId,
      ...content,
      ...(opener ? { opener } : {}),
      locale: readLocale(),
      page: readPage(),
      secondsOnPage: secondsOnPage(),
    },
    deviceHeaders(device),
    true,
  );
  if (response.code === HTTP_CONFLICT) return overQuota(clientMessageId);
  if (response.result !== RESULT.success || !response.body) {
    log(`send failed with ${response.code}`);
    return fail(clientMessageId);
  }
  if (opener) pendingOpener = null;
  const { sent, conversation, online, reply } = response.body;
  const hadConversation = current().conversation !== null;
  publish({
    conversation,
    online,
    messages: mergeLines(withoutClientId(current().messages, clientMessageId), [
      // The tap and the file stay on the line even where the server echoes none.
      {
        ...sent,
        clientMessageId,
        payload: sent.payload ?? tapped,
        ...withAttachments(sent.attachments ?? attachments),
      },
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
    deviceHeaders(device),
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
    deviceHeaders(device),
    true,
  );
  if (response.result !== RESULT.success) return false;
  startBurst();
  return true;
}

/**
 * The visitor's answer to a rating request: a score from 1 to 5 and, if they
 * want, a comment. Shown as given at once; an answer the server already has
 * stands as it was.
 */
export async function rate(messageId: string, score: number, comment?: string): Promise<boolean> {
  const device = await readDevice();
  if (!device) return false;
  const words = comment?.trim() || null;
  const response = await post(
    device.baseUrl,
    `${chatPath(device.clientKey)}/ratings`,
    { installationId: device.installationId, messageId, score, ...(words ? { comment: words } : {}) },
    deviceHeaders(device),
    true,
  );
  if (response.result !== RESULT.success && response.code !== HTTP_CONFLICT) return false;
  publish({
    messages: current().messages.map((m) =>
      m.id === messageId
        ? { ...m, payload: { ...(m.payload ?? {}), rating: { score, comment: words } } }
        : m,
    ),
  });
  return true;
}

/** A file whose link ran out: a fresh one, asked once per file per page. */
export async function refreshAttachment(attachmentId: string): Promise<void> {
  if (refreshedLinks.has(attachmentId) || attachmentId.startsWith('local:')) return;
  refreshedLinks.add(attachmentId);
  const device = await readDevice();
  if (!device) return;
  const fresh = await freshLink(device, attachmentId);
  if (!fresh) return;
  publish({
    messages: current().messages.map((m) =>
      m.attachments?.some((a) => a.id === attachmentId)
        ? { ...m, attachments: m.attachments.map((a) => (a.id === attachmentId ? fresh : a)) }
        : m,
    ),
  });
}

function fail(clientMessageId: string): boolean {
  publish({
    messages: current().messages.map((m) =>
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
  const config = current().config;
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
    messages: mergeLines(withoutClientId(current().messages, clientMessageId), [notice]),
  });
  return false;
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

async function refreshSession(): Promise<void> {
  const device = await readDevice();
  if (!device) return;
  const response = await post<SessionResponse>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/sessions`,
    { installationId: device.installationId, locale: readLocale(), page: readPage() },
    deviceHeaders(device),
    true,
  );
  if (response.result !== RESULT.success || !response.body) return;
  const { online, conversation, messages } = response.body;
  // The proactive message stays shown until the visitor's line takes it to the server.
  const openerKey = pendingOpener;
  const opener = openerKey ? current().messages.filter((m) => m.id === openerId(openerKey)) : [];
  publish({ online, conversation, messages: mergeLines(messages, [...pendingLines(), ...opener]) });
}

function withAttachments(attachments: ChatAttachment[] | undefined): { attachments?: ChatAttachment[] } {
  return attachments?.length ? { attachments } : {};
}

async function loadConfig(): Promise<ChatWidgetConfig | null> {
  const cached = await get<CachedConfig>(KEYS.chatConfig);
  if (cached && Date.now() - cached.fetchedAtMs < CONFIG_TTL_MS) return cached.config;
  const [clientKey, baseUrl] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
  ]);
  if (!clientKey || !baseUrl) return null;
  const response = await getJson<ChatWidgetConfig>(baseUrl, `${chatPath(clientKey)}/config`);
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
