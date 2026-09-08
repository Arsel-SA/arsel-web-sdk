import { describe, expect, it } from 'vitest';
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  backoffMs,
  parseRetryAfter,
} from '../src/retry';

/** Pin the jitter so the curve itself can be asserted. */
const noJitter = () => 0;
const maxJitter = () => 0.999999;

describe('backoffMs', () => {
  it('doubles from the base', () => {
    expect(backoffMs(1, null, noJitter)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2, null, noJitter)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3, null, noJitter)).toBe(BASE_BACKOFF_MS * 4);
  });

  it('caps rather than growing without bound', () => {
    expect(backoffMs(50, null, noJitter)).toBe(MAX_BACKOFF_MS);
  });

  it('adds up to 50% jitter and never subtracts', () => {
    // The whole point: `online` and visibilitychange fire on every device at
    // once, so an exact curve returns a synchronized fleet to the server.
    const base = BASE_BACKOFF_MS;
    expect(backoffMs(1, null, noJitter)).toBe(base);
    expect(backoffMs(1, null, maxJitter)).toBeGreaterThan(base);
    expect(backoffMs(1, null, maxJitter)).toBeLessThanOrEqual(base * 1.5);
  });

  it('treats Retry-After as a floor, not a ceiling', () => {
    // A 60s window reset must not be retried at 5s just because that is where
    // the curve starts.
    expect(backoffMs(1, 60_000, noJitter)).toBe(60_000);
  });

  it('keeps the longer of the curve and Retry-After', () => {
    expect(backoffMs(6, 1_000, noJitter)).toBe(BASE_BACKOFF_MS * 32);
  });

  it('jitters Retry-After too, so a rate-limited fleet does not return in lockstep', () => {
    // Every device throttled inside one window gets the SAME Retry-After.
    expect(backoffMs(1, 60_000, maxJitter)).toBeGreaterThan(60_000);
  });

  it('treats attempt 0 or negative as the first attempt', () => {
    expect(backoffMs(0, null, noJitter)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(-3, null, noJitter)).toBe(BASE_BACKOFF_MS);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('60')).toBe(60_000);
    expect(parseRetryAfter('  0 ')).toBe(0);
  });

  it('reads an HTTP-date as a duration from now', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    const at = new Date(now + 30_000).toUTCString();

    expect(parseRetryAfter(at, now)).toBe(30_000);
  });

  it('never returns a negative wait for a date already past', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    const past = new Date(now - 60_000).toUTCString();

    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('yields null for absent or unparseable values rather than throwing', () => {
    // A header we cannot read must cost us nothing; the curve still applies.
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});
