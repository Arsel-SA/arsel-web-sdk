import { vi } from 'vitest';
import type { ChatState, ChatWidgetConfig } from '../src/chat-types';

/** What the engine's specs share: the widget, a line as the server sends one, and the clocks. */

export const CLIENT_KEY = 'pub_test';
export const BASE_URL = 'https://api.example.test';
export const WIDGET_PATH = `/api/v1/orgs/${CLIENT_KEY}/chat`;

export const CONFIG: ChatWidgetConfig = {
  name: 'Shop chat',
  primaryColor: '#2563EB',
  position: 'right',
  language: 'auto',
  askForEmail: 'never',
  welcomeDelaySeconds: 0,
  collect: { name: true, phone: false },
  texts: {
    en: {
      welcome: 'Hi!',
      placeholder: 'Write…',
      outsideHours: 'Away.',
      offlineForm: 'Leave your email.',
      leadConsent: 'I agree.',
      ratingPrompt: 'How did we do?',
      ratingThanks: 'Thanks!',
    },
    ar: {
      welcome: 'أهلاً',
      placeholder: 'اكتب…',
      outsideHours: 'غير متواجدين.',
      offlineForm: 'اترك بريدك.',
      leadConsent: 'أوافق.',
      ratingPrompt: 'كيف كانت؟',
      ratingThanks: 'شكراً!',
    },
  },
  allowAttachments: true,
  poweredBy: true,
  online: true,
};

/** Lets the fake IndexedDB, which schedules its work on setImmediate, finish what a timer started. */
export async function drained(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Only the clocks the widget uses: the fake IndexedDB schedules its own work
 * on setImmediate. The pacing reads the wall clock, so a test of it fakes
 * `Date` too.
 */
export function useTimers(withDate = false): void {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      ...(withDate ? (['Date'] as const) : []),
    ],
  });
}

/** A line as the server sends it, dated earlier today so nothing paces it unless a test says so. */
export function line(
  id: string,
  direction: 'in' | 'out',
  text: string,
  kind = 'text',
  sender: ChatState['messages'][number]['sender']['kind'] = direction === 'in' ? 'visitor' : 'system',
): ChatState['messages'][number] {
  return {
    id,
    direction,
    at: `2026-11-04T00:00:0${id.length % 10}.000Z`,
    kind,
    text,
    sender: { kind: sender, name: sender === 'agent' ? 'Lina' : null },
  };
}
