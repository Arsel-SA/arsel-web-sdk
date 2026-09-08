/**
 * Retry pacing, mirrored deliberately in the Android and iOS SDKs so a fleet
 * behaves the same whichever platform it is on.
 *
 * The jitter is the point. Every drain trigger this SDK has — `online`,
 * visibilitychange, app foreground — fires on every device at the same instant
 * when a network comes back or a backend recovers. An unjittered curve turns
 * that into a synchronized wall of requests precisely when the server is least
 * able to take it, and each rejection re-synchronizes the fleet for the next
 * round.
 */
export const BASE_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/** Doubling stops here; 5s << 6 is already the 5-minute ceiling. */
const MAX_DOUBLINGS = 6;

/**
 * How long to wait before retrying, given the attempt number (1-based) and
 * whatever the server asked for.
 *
 * `Retry-After` is a floor, never a ceiling: the server knows when its window
 * rolls and we must not come back before it. But it is jittered on top of,
 * because a whole fleet rate-limited inside one window receives the *same*
 * `Retry-After` and would otherwise return in lockstep the moment it expires.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const doublings = Math.min(Math.max(attempt, 1) - 1, MAX_DOUBLINGS);
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** doublings, MAX_BACKOFF_MS);
  const floor = Math.max(retryAfterMs ?? 0, exponential);
  return floor + Math.floor(random() * (floor / 2));
}

/**
 * RFC 7231 `Retry-After`: delta-seconds, or an HTTP-date. Mirrors the Android
 * parser. A malformed value yields null rather than throwing — a header we
 * cannot read must not cost us the retry.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  // An HTTP-date always carries a weekday and month name. Requiring a letter
  // keeps Date.parse's leniency from reading something like "-5" as a year and
  // turning a malformed header into a real instruction.
  if (!/[a-z]/i.test(trimmed)) return null;

  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
