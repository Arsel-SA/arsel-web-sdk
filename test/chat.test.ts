import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatState, ChatWidgetConfig } from '../src/chat-types';

type ChatModule = typeof import('../src/chat');
type StoreModule = typeof import('../src/store');

let chat: ChatModule;
let store: StoreModule;

const CLIENT_KEY = 'pub_test';
const BASE_URL = 'https://api.example.test';
const WIDGET_PATH = `/api/v1/orgs/${CLIENT_KEY}/chat`;

const CONFIG: ChatWidgetConfig = {
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
    },
    ar: {
      welcome: 'أهلاً',
      placeholder: 'اكتب…',
      outsideHours: 'غير متواجدين.',
      offlineForm: 'اترك بريدك.',
      leadConsent: 'أوافق.',
    },
  },
  poweredBy: true,
  online: true,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const calls: Call[] = [];
type Responder = (call: Call) => { status: number; body?: unknown } | undefined;
let respond: Responder = () => undefined;

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: (init?.headers as Record<string, string>) ?? {},
      };
      calls.push(call);
      const answer = respond(call);
      return answer ? json(answer.status, answer.body) : json(404);
    }),
  );
}

const sessions = () => calls.filter((c) => c.path.endsWith('/push/subscriptions'));
const sends = () => calls.filter((c) => c.path.endsWith('/chat/messages') && c.method === 'POST');
const tickets = () => calls.filter((c) => c.path.endsWith('/chat/stream-ticket'));

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
  calls.length = 0;
  respond = () => undefined;
  installFetch();
  vi.stubGlobal('document', { documentElement: { lang: 'en' }, title: 'Shop' });
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('location', { href: 'https://shop.test/shoes' });
  vi.stubGlobal('EventSource', undefined);
  store = await import('../src/store');
  chat = await import('../src/chat');
  await store.set(store.KEYS.clientKey, CLIENT_KEY);
  await store.set(store.KEYS.baseUrl, BASE_URL);
  for (const key of [
    store.KEYS.chatConfig,
    store.KEYS.deviceSecret,
    store.KEYS.installationId,
    store.KEYS.email,
    store.KEYS.phoneNumber,
  ]) {
    await store.remove(key);
  }
});

const OPTIONS = { zIndex: 10 };

/** Lets the fake IndexedDB, which schedules its work on setImmediate, finish what a timer started. */
async function drained(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Only the clocks the widget uses: the fake IndexedDB schedules its own work
 * on setImmediate. The pacing reads the wall clock, so a test of it fakes
 * `Date` too.
 */
function useTimers(withDate = false): void {
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

describe('start()', () => {
  it('draws nothing for an organization without a widget, and remembers that', async () => {
    const drawn = vi.fn();
    chat.setRenderer(drawn);

    await chat.start(OPTIONS, false);
    await chat.start(OPTIONS, false);

    expect(drawn).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path === `${WIDGET_PATH}/config`)).toHaveLength(1);
  });

  it('draws the widget from the config, and reuses the cached config for a while', async () => {
    respond = (call) =>
      call.path === `${WIDGET_PATH}/config` ? { status: 200, body: CONFIG } : undefined;
    const drawn = vi.fn<(state: ChatState) => void>();
    chat.setRenderer(drawn);

    await chat.start(OPTIONS, false);
    vi.resetModules();
    const again = await import('../src/chat');
    again.setRenderer(drawn);
    await again.start(OPTIONS, false);

    expect(drawn).toHaveBeenCalledWith(
      expect.objectContaining({ config: CONFIG, online: true, isOpen: false }),
    );
    expect(calls.filter((c) => c.path === `${WIDGET_PATH}/config`)).toHaveLength(1);
  });

  it('shows the thread of a browser that wrote before, without registering it again', async () => {
    await store.set(store.KEYS.installationId, 'inst-1');
    await store.set(store.KEYS.deviceSecret, 'secret-1');
    respond = (call) => {
      if (call.path === `${WIDGET_PATH}/config`) return { status: 200, body: CONFIG };
      if (call.path === `${WIDGET_PATH}/sessions`) {
        return {
          status: 200,
          body: {
            online: false,
            conversation: { id: 'conv-1', status: 'open', agent: null },
            messages: [line('m1', 'in', 'Hello?')],
          },
        };
      }
      return undefined;
    };

    await chat.start(OPTIONS, false);

    const state = chat.snapshot();
    expect(state.conversation?.id).toBe('conv-1');
    expect(state.messages.map((m) => m.id)).toEqual(['m1']);
    expect(state.online).toBe(false);
    expect(sessions()).toHaveLength(0);
    const session = calls.find((c) => c.path === `${WIDGET_PATH}/sessions`);
    expect(session?.headers['X-Arsel-Device-Auth']).toBe('secret-1');
    expect(session?.body).toMatchObject({ installationId: 'inst-1', locale: 'en' });
  });
});

describe('send()', () => {
  beforeEach(() => {
    respond = (call) => {
      if (call.path === `${WIDGET_PATH}/config`) return { status: 200, body: CONFIG };
      if (call.path.endsWith('/push/subscriptions')) {
        return { status: 200, body: { subscriptionId: 's1', status: 'ACTIVE', deviceSecret: 'secret-9' } };
      }
      if (call.path === `${WIDGET_PATH}/messages` && call.method === 'POST') {
        const body = call.body as { clientMessageId: string; text: string };
        return {
          status: 200,
          body: {
            sent: line('m-' + body.clientMessageId, 'in', body.text),
            conversation: { id: 'conv-1', status: 'open', agent: null },
            online: false,
            reply: line('notice-1', 'out', 'Away.', 'notice'),
          },
        };
      }
      if (call.path === `${WIDGET_PATH}/stream-ticket`) return { status: 200, body: { ticket: 't' } };
      if (call.path.startsWith(`${WIDGET_PATH}/messages?`)) return { status: 200, body: { data: [] } };
      return undefined;
    };
  });

  it('registers the browser on the first message, then sends with the device proof and a message id', async () => {
    await chat.start(OPTIONS, false);

    expect(await chat.send('  Do you ship to Jeddah?  ')).toBe(true);

    expect(sessions()).toHaveLength(1);
    expect(sessions()[0].body).toMatchObject({ platform: 'web', anonymousId: expect.any(String) });
    expect(sends()).toHaveLength(1);
    const sent = sends()[0];
    expect(sent.headers['X-Arsel-Device-Auth']).toBe('secret-9');
    expect(sent.body).toMatchObject({
      text: 'Do you ship to Jeddah?',
      clientMessageId: expect.any(String),
      page: { url: 'https://shop.test/shoes', title: 'Shop' },
    });
    const state = chat.snapshot();
    expect(state.conversation?.id).toBe('conv-1');
    expect(state.online).toBe(false);
    expect(state.messages.map((m) => [m.text, m.pending ?? null])).toEqual([
      ['Do you ship to Jeddah?', null],
      ['Away.', null],
    ]);
  });

  it('keeps a failed line marked, and a retry reuses its id so the server takes it once', async () => {
    await chat.start(OPTIONS, false);
    const base = respond;
    respond = (call) =>
      call.path === `${WIDGET_PATH}/messages` && call.method === 'POST'
        ? { status: 503 }
        : base(call);

    expect(await chat.send('Hello')).toBe(false);
    const failed = chat.snapshot().messages[0];
    expect(failed.pending).toBe('failed');

    respond = base;
    expect(await chat.send('Hello', { retryOf: failed.clientMessageId })).toBe(true);

    expect(sends().map((c) => (c.body as { clientMessageId: string }).clientMessageId)).toEqual([
      failed.clientMessageId,
      failed.clientMessageId,
    ]);
    expect(chat.snapshot().messages.filter((m) => m.pending)).toHaveLength(0);
  });

  it('sends a tapped quick reply with its key, the line it answers, and the time on the page', async () => {
    await chat.start(OPTIONS, false);

    expect(await chat.send('Support', { option: 'support', replyTo: 'q1' })).toBe(true);

    expect(sends()[0].body).toMatchObject({
      text: 'Support',
      option: 'support',
      replyTo: 'q1',
      secondsOnPage: expect.any(Number),
    });
    const [sent] = chat.snapshot().messages;
    expect(sent.payload).toEqual({ option: 'support', replyTo: 'q1' });
  });

  it('polls for replies when the browser has no EventSource: every second and a half right after a send, every ten seconds after that', async () => {
    useTimers();
    await chat.start(OPTIONS, false);
    await chat.send('Hello');
    const polled = () => calls.filter((c) => c.path.startsWith(`${WIDGET_PATH}/messages?`));
    expect(tickets()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    await drained();
    expect(polled()).toHaveLength(1);
    // The notice came after the visitor's line, so the catch-up starts from it.
    expect(polled()[0].path).toContain('after=notice-1');

    await vi.advanceTimersByTimeAsync(13_500);
    await drained();
    // Ten quick fetches over fifteen seconds, plus the ten-second poll at ten
    // when the fake IndexedDB has let it through.
    const burst = polled().length;
    expect(burst).toBeGreaterThanOrEqual(10);
    expect(burst).toBeLessThanOrEqual(11);

    // The burst is over: the ten-second poll alone goes on (covered below).
    await vi.advanceTimersByTimeAsync(20_000);
    await drained();
    expect(polled().length - burst).toBeLessThanOrEqual(2);
    chat.stop();
  });

  it('drops the line, shows the outside-hours notice and draws the team away when the organization is out of conversations', async () => {
    await chat.start(OPTIONS, false);
    const base = respond;
    respond = (call) =>
      call.path === `${WIDGET_PATH}/messages` && call.method === 'POST'
        ? { status: 409, body: { statusCode: 409, message: 'quota_exceeded' } }
        : base(call);

    expect(await chat.send('Hello')).toBe(false);

    const state = chat.snapshot();
    expect(state.overQuota).toBe(true);
    expect(state.online).toBe(false);
    expect(state.messages.map((m) => [m.kind, m.text, m.sender.kind])).toEqual([
      ['notice', 'Away.', 'system'],
    ]);
  });

  it('reveals a line the bot just wrote after a typing pause, and redraws when it is due', async () => {
    useTimers(true);
    const drawn = vi.fn<(state: ChatState) => void>();
    chat.setRenderer(drawn);
    const base = respond;
    respond = (call) => {
      if (call.path === `${WIDGET_PATH}/messages` && call.method === 'POST') {
        const body = call.body as { clientMessageId: string; text: string };
        return {
          status: 200,
          body: {
            sent: line('m-' + body.clientMessageId, 'in', body.text),
            conversation: { id: 'conv-1', status: 'open', agent: null },
            online: true,
            reply: { ...line('b1', 'out', 'Welcome! Pick one.', 'choices', 'bot'), at: new Date().toISOString() },
          },
        };
      }
      return base(call);
    };
    await chat.start(OPTIONS, false);

    await chat.send('Hello');

    const reply = chat.snapshot().messages.find((m) => m.id === 'b1');
    expect(reply?.revealAt).toBeGreaterThan(Date.now());
    expect(reply?.revealAt).toBeLessThanOrEqual(Date.now() + 1_800);
    const before = drawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_800);
    expect(drawn.mock.calls.length).toBeGreaterThan(before);
    expect(reply?.revealAt).toBeLessThanOrEqual(Date.now());
    chat.stop();
  });

  it('shows a line a teammate wrote, and an old line of the bot, at once', async () => {
    const base = respond;
    respond = (call) =>
      call.path.startsWith(`${WIDGET_PATH}/messages?`)
        ? {
            status: 200,
            body: {
              data: [
                { ...line('a1', 'out', 'Hi, Lina here', 'text', 'agent'), at: new Date().toISOString() },
                line('b0', 'out', 'An hour ago', 'text', 'bot'),
              ],
            },
          }
        : base(call);
    useTimers();
    await chat.start(OPTIONS, false);
    await chat.send('Hello');

    await vi.advanceTimersByTimeAsync(1_500);
    await drained();

    const revealed = chat.snapshot().messages.filter((m) => m.id === 'a1' || m.id === 'b0');
    expect(revealed).toHaveLength(2);
    expect(revealed.every((m) => m.revealAt === undefined)).toBe(true);
    chat.stop();
  });

  it('counts a line from the team unread while the window is closed, and clears it on open', async () => {
    useTimers();
    await chat.start(OPTIONS, false);
    await chat.send('Hello');
    const base = respond;
    respond = (call) =>
      call.path.startsWith(`${WIDGET_PATH}/messages?`)
        ? { status: 200, body: { data: [line('a1', 'out', 'Yes, we do.')] } }
        : base(call);

    await vi.advanceTimersByTimeAsync(10_000);
    await drained();
    expect(chat.snapshot().unread).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await drained();
    expect(chat.snapshot().unread).toBe(1);

    await chat.open();
    expect(chat.snapshot().unread).toBe(0);
    expect(chat.snapshot().messages.map((m) => m.id)).toContain('a1');
    chat.stop();
  });
});

describe('submitLead()', () => {
  it('sends the lead with the device proof and remembers the address', async () => {
    await store.set(store.KEYS.installationId, 'inst-1');
    await store.set(store.KEYS.deviceSecret, 'secret-1');
    respond = (call) => {
      if (call.path === `${WIDGET_PATH}/config`) return { status: 200, body: CONFIG };
      if (call.path === `${WIDGET_PATH}/sessions`) {
        return { status: 200, body: { online: true, conversation: null, messages: [] } };
      }
      if (call.path === `${WIDGET_PATH}/leads`) return { status: 200, body: { identified: true } };
      return undefined;
    };
    await chat.start(OPTIONS, false);

    expect(await chat.submitLead({ email: 'lina@shop.test', consent: true })).toBe(true);

    const lead = calls.find((c) => c.path === `${WIDGET_PATH}/leads`);
    expect(lead?.body).toEqual({ installationId: 'inst-1', email: 'lina@shop.test', consent: true });
    expect(await store.get(store.KEYS.email)).toBe('lina@shop.test');
    expect(chat.snapshot().identified).toBe(true);
  });

  it('names the form request a lead answers, and the one the visitor skipped', async () => {
    await store.set(store.KEYS.installationId, 'inst-1');
    await store.set(store.KEYS.deviceSecret, 'secret-1');
    respond = (call) => {
      if (call.path === `${WIDGET_PATH}/config`) return { status: 200, body: CONFIG };
      if (call.path === `${WIDGET_PATH}/sessions`) {
        return { status: 200, body: { online: true, conversation: null, messages: [] } };
      }
      if (call.path === `${WIDGET_PATH}/leads`) return { status: 200, body: { identified: true } };
      return undefined;
    };
    await chat.start(OPTIONS, false);

    expect(await chat.submitLead({ phone: '+966501234567', consent: false }, 'f1')).toBe(true);
    expect(await chat.skipForm('f2')).toBe(true);

    const leads = calls.filter((c) => c.path === `${WIDGET_PATH}/leads`).map((c) => c.body);
    expect(leads).toEqual([
      { installationId: 'inst-1', phone: '+966501234567', consent: false, requestId: 'f1' },
      { installationId: 'inst-1', requestId: 'f2', skipped: true, consent: false },
    ]);
  });
});

describe('open()', () => {
  it('waits for a start still loading, so a site button pressed right after init opens the window', async () => {
    respond = (call) =>
      call.path === `${WIDGET_PATH}/config` ? { status: 200, body: CONFIG } : undefined;

    const starting = chat.start(OPTIONS, false);
    await chat.open();

    expect(chat.snapshot().isOpen).toBe(true);
    await starting;
  });
});

describe('resolveLocale()', () => {
  it('follows the page language unless the organization pinned one', () => {
    expect(chat.resolveLocale(CONFIG)).toBe('en');
    vi.stubGlobal('document', { documentElement: { lang: 'ar-SA' }, title: '' });
    expect(chat.resolveLocale(CONFIG)).toBe('ar');
    expect(chat.resolveLocale({ ...CONFIG, language: 'en' })).toBe('en');
  });
});

/** A line as the server sends it, dated earlier today so nothing paces it unless a test says so. */
function line(
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
