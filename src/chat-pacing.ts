import { current, publish } from './chat-state';
import type { ChatMessage } from './chat-types';

/**
 * A bot's line that just arrived is revealed after a pause that reads as
 * typing, one line after another; the view draws the dots meanwhile. A
 * teammate's line, a notice and anything older show at once.
 */

const MS_PER_SECOND = 1000;
/** A bot's line is revealed after a pause that reads as typing: this long, plus a little per character. */
const TYPING_BASE_MS = 500;
const TYPING_PER_CHARACTER_MS = 12;
const TYPING_MAX_MS = 1800;
/** Only a line that just arrived is paced; history and catch-up after a long gap show at once. */
const PACED_LINE_MAX_AGE_MS = 30 * MS_PER_SECOND;

let revealTimer: ReturnType<typeof setTimeout> | null = null;
let lastRevealAtMs = 0;

export function paced(message: ChatMessage): ChatMessage {
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
  const due = current()
    .messages.map((m) => m.revealAt ?? 0)
    .filter((at) => at > Date.now())
    .concat(revealAt);
  const next = Math.min(...due);
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(
    () => {
      revealTimer = null;
      publish({});
      const pending = current().messages.some((m) => (m.revealAt ?? 0) > Date.now());
      if (pending) scheduleReveal(Infinity);
    },
    Math.max(0, next - Date.now()),
  );
}

export function stopPacing(): void {
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
}
