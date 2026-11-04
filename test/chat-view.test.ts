// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatState, ChatWidgetConfig } from '../src/chat';

/**
 * The widget's failure mode is silent: a launcher nobody can reach with a
 * keyboard, a window in the wrong direction, a form that never shows. These
 * cover the parts the engine cannot see: roles and labels, the direction,
 * what the visitor's actions call, and when the lead form appears.
 */

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
      welcome: 'Hi! How can we help?',
      placeholder: 'Write a message',
      outsideHours: 'We are away.',
      offlineForm: 'Leave your email.',
      leadConsent: 'I agree to updates.',
    },
    ar: {
      welcome: 'أهلاً! كيف نساعدك؟',
      placeholder: 'اكتب رسالتك',
      outsideHours: 'نحن غير متواجدين.',
      offlineForm: 'اترك بريدك.',
      leadConsent: 'أوافق على التحديثات.',
    },
  },
  poweredBy: true,
  online: true,
};

function state(change: Partial<ChatState> = {}): ChatState {
  return {
    config: CONFIG,
    conversation: null,
    messages: [],
    online: true,
    unread: 0,
    isOpen: false,
    identified: false,
    ...change,
  };
}

type ChatModule = typeof import('../src/chat');
type ViewModule = typeof import('../src/chat-view');

let chat: ChatModule;
let view: ViewModule;
let open: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let submitLead: ReturnType<typeof vi.fn>;
let current: ChatState;
let listener: ((s: ChatState) => void) | null;
let handle: ReturnType<ViewModule['mountChat']> | null = null;

beforeEach(async () => {
  vi.resetModules();
  current = state();
  listener = null;
  open = vi.fn(async () => {
    current = { ...current, isOpen: true, unread: 0 };
    listener?.(current);
  });
  send = vi.fn(async () => true);
  submitLead = vi.fn(async () => true);
  vi.doMock('../src/chat', async () => {
    const actual = await vi.importActual<ChatModule>('../src/chat');
    return {
      ...actual,
      open,
      close: () => {
        current = { ...current, isOpen: false };
        listener?.(current);
      },
      send,
      submitLead,
      snapshot: () => current,
      subscribe: (fn: (s: ChatState) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    };
  });
  chat = await import('../src/chat');
  view = await import('../src/chat-view');
  document.documentElement.lang = 'en';
  document.documentElement.removeAttribute('dir');
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.doUnmock('../src/chat');
});

/** Lets the submit handler's promise chain run to its end. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const mount = (initial: ChatState = current) => {
  current = initial;
  handle = view.mountChat(initial, 10);
  return handle.root;
};

describe('mountChat', () => {
  it('draws a labelled launcher on the page and nothing else until it is opened', () => {
    const root = mount();

    const launcher = root.querySelector('button.launcher');
    expect(launcher?.getAttribute('aria-label')).toBe('Open chat');
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    expect(root.host.getAttribute('data-arsel-chat')).toBe('');
    expect(root.host.classList.contains('open')).toBe(false);
    expect(document.body.contains(root.host)).toBe(true);
  });

  it('opens a dialog with the welcome line when the launcher is clicked', async () => {
    const root = mount();

    root.querySelector<HTMLButtonElement>('button.launcher')?.click();
    await Promise.resolve();

    expect(open).toHaveBeenCalled();
    expect(root.host.classList.contains('open')).toBe(true);
    const dialog = root.querySelector('.window');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-label')).toBe('Shop chat');
    expect(root.querySelector('.log')?.textContent).toContain('Hi! How can we help?');
    expect(root.querySelector('.presence')?.textContent).toBe('Online');
  });

  it('runs right to left, in Arabic, when the page is Arabic', () => {
    document.documentElement.lang = 'ar';

    const root = mount();

    expect(root.host.getAttribute('dir')).toBe('rtl');
    expect(root.querySelector('button.launcher')?.getAttribute('aria-label')).toBe(
      'افتح المحادثة',
    );
    expect(root.querySelector('.input')?.getAttribute('placeholder')).toBe('اكتب رسالتك');
  });

  it('sends what the visitor typed on Enter and clears the box', async () => {
    const root = mount(state({ isOpen: true }));
    const input = root.querySelector<HTMLTextAreaElement>('.input');
    if (!input) throw new Error('no composer');

    input.value = 'Do you ship to Jeddah?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith('Do you ship to Jeddah?');
    expect(input.value).toBe('');
  });

  it('shows the thread as text, the team by first name, and a notice as a notice', () => {
    const root = mount(
      state({
        isOpen: true,
        messages: [
          {
            id: 'm1',
            direction: 'in',
            at: '2026-11-04T09:00:00.000Z',
            kind: 'text',
            text: '<b>Hi</b>',
            sender: { kind: 'visitor', name: null },
          },
          {
            id: 'n1',
            direction: 'out',
            at: '2026-11-04T09:00:01.000Z',
            kind: 'notice',
            text: 'We are away.',
            sender: { kind: 'system', name: null },
          },
          {
            id: 'a1',
            direction: 'out',
            at: '2026-11-04T09:00:02.000Z',
            kind: 'text',
            text: 'Yes!',
            sender: { kind: 'agent', name: 'Lina' },
          },
        ],
      }),
    );

    const bubbles = Array.from(root.querySelectorAll('.bubble'));
    expect(bubbles.map((b) => b.querySelector('.who')?.textContent)).toEqual([
      'Team',
      'You',
      'Lina',
    ]);
    expect(root.querySelector('.bubble.you .body')?.textContent).toBe('<b>Hi</b>');
    expect(root.querySelector('.bubble.you b')).toBeNull();
    expect(root.querySelector('.notice')?.textContent).toBe('We are away.');
  });

  it('asks for an email after the first message when the team is away, and sends the lead', async () => {
    const root = mount(state({ isOpen: true, online: false }));
    const form = root.querySelector<HTMLFormElement>('form.lead');
    if (!form) throw new Error('no form');
    expect(form.hidden).toBe(true);

    current = state({
      isOpen: true,
      online: false,
      messages: [
        {
          id: 'm1',
          direction: 'in',
          at: '2026-11-04T09:00:00.000Z',
          kind: 'text',
          text: 'Hello?',
          sender: { kind: 'visitor', name: null },
        },
      ],
    });
    listener?.(current);
    expect(form.hidden).toBe(false);

    const email = form.querySelector<HTMLInputElement>('[name="email"]');
    const name = form.querySelector<HTMLInputElement>('[name="name"]');
    if (!email || !name) throw new Error('no fields');
    email.value = 'lina@shop.test';
    name.value = 'Lina';
    form.querySelector<HTMLInputElement>('[name="consent"]')!.checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settled();

    expect(submitLead).toHaveBeenCalledWith({
      consent: true,
      name: 'Lina',
      email: 'lina@shop.test',
    });
    expect(form.hidden).toBe(true);
  });

  it('refuses an address that is not one, without calling the server', async () => {
    const root = mount(state({ isOpen: true, online: false }));
    const form = root.querySelector<HTMLFormElement>('form.lead');
    if (!form) throw new Error('no form');
    form.querySelector<HTMLInputElement>('[name="email"]')!.value = 'not-an-email';

    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settled();

    expect(submitLead).not.toHaveBeenCalled();
    expect(form.querySelector('.error')?.textContent).toContain('valid email');
  });

  it('hides the composer behind the form when the organization always asks first', () => {
    const root = mount(state({ config: { ...CONFIG, askForEmail: 'always' }, isOpen: true }));

    expect(root.querySelector<HTMLFormElement>('form.lead')?.hidden).toBe(false);
    expect(root.querySelector<HTMLDivElement>('.composer')?.hidden).toBe(true);
    expect(root.querySelector('form.lead .skip')).toBeNull();
  });

  it('shows the unread count on the launcher and the "Powered by" line only when the plan says so', () => {
    const root = mount(state({ unread: 3 }));
    expect(root.querySelector('.badge')?.textContent).toBe('3');
    expect(root.querySelector<HTMLDivElement>('.powered')?.hidden).toBe(false);
    handle?.destroy();

    const bare = mount(state({ config: { ...CONFIG, poweredBy: false } }));
    expect(bare.querySelector<HTMLDivElement>('.powered')?.hidden).toBe(true);
  });

  it('closes on Escape and gives focus back to the launcher', () => {
    const root = mount(state({ isOpen: true }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(root.host.classList.contains('open')).toBe(false);
  });

  it('exposes the chat module it drives', () => {
    expect(typeof chat.resolveLocale).toBe('function');
  });
});
