import { chatPath, deviceHeaders, readDevice } from './chat-device';
import { current, isLocal, subscribe } from './chat-state';
import { RESULT, post } from './transport';

/**
 * What the team sees of the visitor beyond their lines: that they are
 * writing, and how far they have read. Typing goes out at most every few
 * seconds and only once there is a conversation; a read goes out once the
 * window shows a new line from the team, on a page in front.
 */

const TYPING_EVERY_MS = 3000;
/** A burst of lines settles into one read report. */
const READ_SETTLE_MS = 800;

let lastTypingAtMs = 0;
let lastReadId: string | null = null;
let readTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

/** The visitor typed in the composer. */
export function noteTyping(): void {
  const state = current();
  if (!state.conversation || state.conversation.status === 'resolved') return;
  const now = Date.now();
  if (now - lastTypingAtMs < TYPING_EVERY_MS) return;
  lastTypingAtMs = now;
  void (async () => {
    const device = await readDevice();
    if (!device) return;
    await post(
      device.baseUrl,
      `${chatPath(device.clientKey)}/typing`,
      { installationId: device.installationId },
      deviceHeaders(device),
      true,
    );
  })();
}

export function watchReads(): void {
  stopReads();
  unsubscribe = subscribe(scheduleRead);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', scheduleRead);
  }
}

export function stopReads(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (readTimer) clearTimeout(readTimer);
  readTimer = null;
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
    document.removeEventListener('visibilitychange', scheduleRead);
  }
  lastReadId = null;
  lastTypingAtMs = 0;
}

function scheduleRead(): void {
  const newest = newestSeenTeamLine();
  if (!newest || newest === lastReadId || readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    void report();
  }, READ_SETTLE_MS);
}

async function report(): Promise<void> {
  const upTo = newestSeenTeamLine();
  if (!upTo || upTo === lastReadId) return;
  const device = await readDevice();
  if (!device) return;
  lastReadId = upTo;
  const response = await post(
    device.baseUrl,
    `${chatPath(device.clientKey)}/read`,
    { installationId: device.installationId, upTo },
    deviceHeaders(device),
    true,
  );
  // Lost on the way: the next line, or the next look, tries again. A refusal stands.
  if (response.result === RESULT.retryable) lastReadId = null;
}

/** The newest line from the team the visitor can see right now: the window open, the page in front, the line revealed. */
function newestSeenTeamLine(): string | null {
  const state = current();
  if (!state.isOpen || !state.conversation) return null;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
  const now = Date.now();
  const line = [...state.messages]
    .reverse()
    .find(
      (m) =>
        m.direction === 'out' &&
        !isLocal(m) &&
        !m.pending &&
        !(m.revealAt && m.revealAt > now),
    );
  return line?.id ?? null;
}
