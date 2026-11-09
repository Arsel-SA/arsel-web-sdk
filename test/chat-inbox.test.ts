import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatProactiveMessage } from '../src/chat-types';
import {
  BASE_URL,
  CLIENT_KEY,
  CONFIG,
  WIDGET_PATH,
  drained,
  line,
  useTimers,
} from './chat-fixtures';

/**
 * The widget's side of the inbox: the stream's typing and read frames, a
 * line the server updates, files, ratings, the visitor's own typing and
 * reads, proactive messages and the stream's fallback to polling.
 */

type ChatModule = typeof import('../src/chat');
type StreamModule = typeof import('../src/chat-stream');
type StateModule = typeof import('../src/chat-state');
type StoreModule = typeof import('../src/store');

let chat: ChatModule;
let stream: StreamModule;
let chatState: StateModule;
let store: StoreModule;

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const calls: Call[] = [];
type Responder = (call: Call) => { status: number; body?: unknown } | undefined;
let respond: Responder = () => undefined;

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        // A file upload's body is a form, kept as it is.
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null),
        headers: (init?.headers as Record<string, string>) ?? {},
      };
      calls.push(call);
      const answer = respond(call);
      const status = answer?.status ?? 404;
      return new Response(JSON.stringify(answer?.body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const posted = (suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.split('?')[0] === `${WIDGET_PATH}/${suffix}`);

const CONVERSATION = { id: 'conv-1', status: 'open', agent: null };

/** The server of a visitor who wrote before: a session with a conversation, and every send stored. */
function chattingServer(extra: Responder = () => undefined): Responder {
  return (call) => {
    const answer = extra(call);
    if (answer) return answer;
    if (call.path === `${WIDGET_PATH}/config`) return { status: 200, body: CONFIG };
    if (call.path === `${WIDGET_PATH}/sessions`) {
      return {
        status: 200,
        body: { online: true, conversation: CONVERSATION, messages: [line('m1', 'in', 'Hi')] },
      };
    }
    if (call.path === `${WIDGET_PATH}/messages` && call.method === 'POST') {
      const body = call.body as { clientMessageId: string; text?: string };
      return {
        status: 200,
        body: {
          sent: line(`s-${body.clientMessageId}`, 'in', body.text ?? '', body.text ? 'text' : 'file'),
          conversation: CONVERSATION,
          online: true,
          reply: null,
        },
      };
    }
    if (call.path.startsWith(`${WIDGET_PATH}/messages?`)) return { status: 200, body: { data: [] } };
    return undefined;
  };
}

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
  stream = await import('../src/chat-stream');
  chatState = await import('../src/chat-state');
  await store.set(store.KEYS.clientKey, CLIENT_KEY);
  await store.set(store.KEYS.baseUrl, BASE_URL);
  await store.set(store.KEYS.installationId, 'inst-1');
  await store.set(store.KEYS.deviceSecret, 'secret-1');
  for (const key of [store.KEYS.chatConfig, store.KEYS.chatProactive, store.KEYS.email]) {
    await store.remove(key);
  }
});

const OPTIONS = { zIndex: 10 };

describe('the stream', () => {
  it('shows a teammate typing, by first name, until their line lands', async () => {
    respond = chattingServer();
    await chat.start(OPTIONS, false);

    stream.handleFrame({ event: 'typing', data: { agent: { name: 'Lina' } } });
    expect(chat.snapshot().agentTyping?.name).toBe('Lina');

    stream.handleFrame({ event: 'message', data: line('a1', 'out', 'Here to help', 'text', 'agent') });
    expect(chat.snapshot().agentTyping).toBeNull();
    chat.stop();
  });

  it('marks the visitor’s lines read up to when a teammate opened the thread', async () => {
    respond = chattingServer();
    await chat.start(OPTIONS, false);

    stream.handleFrame({ event: 'read', data: { at: '2026-11-08T10:00:00.000Z' } });

    expect(chat.snapshot().conversation?.agentReadAt).toBe('2026-11-08T10:00:00.000Z');
    chat.stop();
  });

  it('replaces a line the server changed, and takes no update for a line it never showed', async () => {
    respond = chattingServer();
    await chat.start(OPTIONS, false);
    const request = { ...line('r1', 'out', 'How did we do?', 'rating'), payload: { rating: { score: null, comment: null } } };
    stream.handleFrame({ event: 'message', data: request });

    stream.handleFrame({
      event: 'message_updated',
      data: { ...request, payload: { rating: { score: 4, comment: null } } },
    });
    stream.handleFrame({ event: 'message_updated', data: line('ghost', 'out', 'Never seen') });

    const lines = chat.snapshot().messages;
    expect(lines.find((m) => m.id === 'r1')?.payload?.rating?.score).toBe(4);
    expect(lines.some((m) => m.id === 'ghost')).toBe(false);
    chat.stop();
  });

  it('shows a file the malware scanner cleared, or removed, in the line that holds it', async () => {
    respond = chattingServer();
    await chat.start(OPTIONS, false);
    const checking = { id: 'f1', name: 'photo.jpg', contentType: 'image/jpeg', size: 10, url: null, scan: 'pending' };
    stream.handleFrame({
      event: 'message',
      data: { ...line('v1', 'in', '', 'file'), attachments: [checking] },
    });

    stream.handleFrame({
      event: 'attachment_updated',
      data: { messageId: 'v1', attachment: { ...checking, url: 'https://files.test/f1', scan: undefined } },
    });
    expect(chat.snapshot().messages.find((m) => m.id === 'v1')?.attachments).toEqual([
      { ...checking, url: 'https://files.test/f1', scan: undefined },
    ]);

    stream.handleFrame({
      event: 'attachment_updated',
      data: { messageId: 'v1', attachment: { ...checking, scan: 'infected' } },
    });
    expect(chat.snapshot().messages.find((m) => m.id === 'v1')?.attachments?.[0]).toMatchObject({
      url: null,
      scan: 'infected',
    });
    chat.stop();
  });

  it('polls after three refused stream tickets, instead of asking for a ticket every two seconds', async () => {
    vi.stubGlobal(
      'EventSource',
      class {
        close(): void {}
      },
    );
    useTimers();
    respond = chattingServer();
    await chat.start(OPTIONS, false);
    await drained();
    const tickets = () => posted('stream-ticket');
    expect(tickets()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await drained();
    await vi.advanceTimersByTimeAsync(8_000);
    await drained();
    expect(tickets()).toHaveLength(3);

    for (let tick = 0; tick < 6; tick += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drained();
    }
    expect(tickets()).toHaveLength(3);
    expect(calls.filter((c) => c.path.startsWith(`${WIDGET_PATH}/messages?`)).length).toBeGreaterThanOrEqual(5);
    chat.stop();
  });
});

describe('sendFile()', () => {
  const file = (size = 2_048, type = 'image/png') =>
    new File([new Uint8Array(size)], 'receipt.png', { type });

  it('refuses a file too big, or of another type, before anything goes out', async () => {
    respond = chattingServer();
    await chat.start(OPTIONS, false);
    calls.length = 0;

    expect(await chat.sendFile(file(11 * 1024 * 1024))).toBe('too_large');
    expect(await chat.sendFile(file(10, 'text/html'))).toBe('type');

    expect(calls).toHaveLength(0);
    chat.stop();
  });

  it('uploads with the device proof in the query and the header, then sends the line with the file and no words', async () => {
    const attachment = { id: 'att-1', name: 'receipt.png', contentType: 'image/png', size: 2048, url: 'https://files.test/a' };
    respond = chattingServer((call) =>
      call.path.startsWith(`${WIDGET_PATH}/attachments?`) ? { status: 201, body: attachment } : undefined,
    );
    await chat.start(OPTIONS, false);

    expect(await chat.sendFile(file())).toBeNull();

    const [uploaded] = posted('attachments');
    expect(uploaded?.path).toBe(`${WIDGET_PATH}/attachments?installationId=inst-1`);
    expect(uploaded?.headers['X-Arsel-Device-Auth']).toBe('secret-1');
    expect((uploaded?.body as FormData).get('file')).toBeInstanceOf(File);
    const [sent] = posted('messages');
    expect(sent?.body).toMatchObject({ attachmentId: 'att-1' });
    expect(sent?.body).not.toHaveProperty('text');
    const shown = chat.snapshot().messages.at(-1);
    expect(shown?.attachments).toEqual([attachment]);
    chat.stop();
  });

  it('retries a file whose upload worked without uploading it again', async () => {
    const attachment = { id: 'att-2', name: 'receipt.png', contentType: 'image/png', size: 2048, url: 'https://files.test/b' };
    let sendsRefused = true;
    respond = chattingServer((call) => {
      if (call.path.startsWith(`${WIDGET_PATH}/attachments?`)) return { status: 201, body: attachment };
      if (call.path === `${WIDGET_PATH}/messages` && call.method === 'POST' && sendsRefused) {
        return { status: 503 };
      }
      return undefined;
    });
    await chat.start(OPTIONS, false);

    expect(await chat.sendFile(file())).toBe('failed');
    const failed = chat.snapshot().messages.find((m) => m.pending === 'failed');
    expect(failed?.clientMessageId).toBeDefined();
    sendsRefused = false;
    expect(await chat.retry(failed?.clientMessageId ?? '')).toBe(true);

    expect(posted('attachments')).toHaveLength(1);
    expect(posted('messages')).toHaveLength(2);
    chat.stop();
  });
});

describe('rate()', () => {
  it('sends the score and the comment, and shows the line answered', async () => {
    respond = chattingServer((call) =>
      call.path === `${WIDGET_PATH}/ratings` ? { status: 200, body: { ok: true } } : undefined,
    );
    await chat.start(OPTIONS, false);
    stream.handleFrame({ event: 'message', data: line('r1', 'out', 'How did we do?', 'rating') });

    expect(await chat.rate('r1', 5, '  Quick and kind  ')).toBe(true);

    expect(posted('ratings')[0]?.body).toEqual({
      installationId: 'inst-1',
      messageId: 'r1',
      score: 5,
      comment: 'Quick and kind',
    });
    expect(chat.snapshot().messages.find((m) => m.id === 'r1')?.payload?.rating).toEqual({
      score: 5,
      comment: 'Quick and kind',
    });
    chat.stop();
  });
});

describe('the visitor’s typing and reads', () => {
  it('tells the team the visitor is typing at most every three seconds, and only in a conversation', async () => {
    useTimers(true);
    respond = chattingServer();
    await chat.start(OPTIONS, false);

    chat.noteTyping();
    chat.noteTyping();
    await drained();
    expect(posted('typing')).toHaveLength(1);

    vi.setSystemTime(Date.now() + 3_000);
    chat.noteTyping();
    await drained();
    expect(posted('typing')).toHaveLength(2);

    chatState.publish({ conversation: null });
    vi.setSystemTime(Date.now() + 3_000);
    chat.noteTyping();
    await drained();
    expect(posted('typing')).toHaveLength(2);
    chat.stop();
  });

  it('reports the newest team line the open window shows, once', async () => {
    useTimers();
    respond = chattingServer((call) =>
      call.path === `${WIDGET_PATH}/read` ? { status: 200, body: { ok: true } } : undefined,
    );
    await chat.start(OPTIONS, false);
    stream.handleFrame({ event: 'message', data: line('a1', 'out', 'Hello', 'text', 'agent') });

    await chat.open();
    await vi.advanceTimersByTimeAsync(800);
    await drained();
    chatState.publish({});
    await vi.advanceTimersByTimeAsync(800);
    await drained();

    expect(posted('read').map((c) => c.body)).toEqual([{ installationId: 'inst-1', upTo: 'a1' }]);
    chat.stop();
  });
});

describe('proactive messages', () => {
  const HELP: ChatProactiveMessage = {
    key: 'help',
    trigger: 'time_on_page',
    seconds: 5,
    urlContains: '/shoes',
    when: 'always',
    display: 'teaser',
    everyDays: 1,
    text: { en: 'Need a hand?', ar: 'تحتاج مساعدة؟' },
  };

  function proactiveServer(messages: ChatProactiveMessage[]): Responder {
    return (call) => {
      if (call.path === `${WIDGET_PATH}/config`) {
        return { status: 200, body: { ...CONFIG, proactive: messages } };
      }
      if (call.path === `${WIDGET_PATH}/sessions`) {
        return { status: 200, body: { online: true, conversation: null, messages: [] } };
      }
      return chattingServer()(call);
    };
  }

  beforeEach(() => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  it('shows the message after its seconds on a matching page, opens the thread on it, and sends its key with the first line only', async () => {
    useTimers();
    respond = proactiveServer([HELP]);
    await chat.start(OPTIONS, false);

    await vi.advanceTimersByTimeAsync(5_000);
    await drained();
    expect(chat.snapshot().proactive).toEqual({ key: 'help', text: 'Need a hand?', display: 'teaser' });

    await chat.open();
    expect(chat.snapshot().messages.map((m) => [m.id, m.text])).toContainEqual([
      'local:proactive:help',
      'Need a hand?',
    ]);
    await chat.send('Yes please');
    await chat.send('My size is 42');

    const [first, second] = posted('messages');
    expect(first?.body).toMatchObject({ text: 'Yes please', opener: 'help' });
    expect(second?.body).not.toHaveProperty('opener');
    chat.stop();
  });

  it('shows nothing on a page whose address does not match, and nothing twice the same day', async () => {
    useTimers();
    respond = proactiveServer([{ ...HELP, urlContains: '/checkout' }, { ...HELP, key: 'again', urlContains: null }]);
    await chat.start(OPTIONS, false);
    await vi.advanceTimersByTimeAsync(5_000);
    await drained();
    expect(chat.snapshot().proactive?.key).toBe('again');
    chat.stop();

    vi.resetModules();
    const fresh = await import('../src/chat');
    await fresh.start(OPTIONS, false);
    await vi.advanceTimersByTimeAsync(5_000);
    await drained();
    expect(fresh.snapshot().proactive ?? null).toBeNull();
    fresh.stop();
  });

  it('tells the server the message showed, and that the visitor opened its teaser, once each', async () => {
    useTimers();
    respond = proactiveServer([HELP]);
    await chat.start(OPTIONS, false);
    await vi.advanceTimersByTimeAsync(5_000);
    await drained();

    await chat.open();
    chat.close();
    await chat.open();
    await drained();

    expect(posted('proactive').map((c) => c.body)).toEqual([
      { key: 'help', event: 'shown', installationId: 'inst-1' },
      { key: 'help', event: 'opened', installationId: 'inst-1' },
    ]);
    // Asked of a visitor who may never have written: no device proof goes with it.
    expect(posted('proactive')[0]?.headers).not.toHaveProperty('X-Arsel-Device-Auth');
    chat.stop();
  });

  it('counts a message that opens the window itself as shown, never as opened', async () => {
    useTimers();
    respond = proactiveServer([{ ...HELP, display: 'open' }]);
    await chat.start(OPTIONS, false);
    await vi.advanceTimersByTimeAsync(5_000);
    await drained();

    expect(chat.snapshot().isOpen).toBe(true);
    expect(posted('proactive').map((c) => (c.body as { event: string }).event)).toEqual(['shown']);
    chat.stop();
  });

  it('fires no teaser once the visitor had the window open on the page: it would never be drawn', async () => {
    useTimers();
    respond = proactiveServer([HELP]);
    await chat.start(OPTIONS, false);
    await chat.open();
    chat.close();

    await vi.advanceTimersByTimeAsync(5_000);
    await drained();

    expect(chat.snapshot().proactive ?? null).toBeNull();
    expect(posted('proactive')).toEqual([]);
    chat.stop();
  });

  it('sends no key once the visitor dismissed the message', async () => {
    useTimers();
    respond = proactiveServer([HELP]);
    await chat.start(OPTIONS, false);
    await vi.advanceTimersByTimeAsync(5_000);
    await drained();

    chat.dismissProactive();
    await chat.send('Just browsing');

    expect(chat.snapshot().proactive).toBeNull();
    expect(posted('messages')[0]?.body).not.toHaveProperty('opener');
    chat.stop();
  });
});
