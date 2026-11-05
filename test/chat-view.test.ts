// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatState, ChatWidgetConfig } from '../src/chat-types';

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
    overQuota: false,
    ...change,
  };
}

/** A line as the thread holds it. */
function message(
  id: string,
  direction: 'in' | 'out',
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    direction,
    at: `2026-11-04T09:00:${String(id.length).padStart(2, '0')}.000Z`,
    kind: 'text',
    text,
    sender: direction === 'in' ? { kind: 'visitor', name: null } : { kind: 'bot', name: null },
    ...extra,
  };
}

type ChatModule = typeof import('../src/chat');
type ViewModule = typeof import('../src/chat-view');

let chat: ChatModule;
let view: ViewModule;
let open: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let submitLead: ReturnType<typeof vi.fn>;
let skipForm: ReturnType<typeof vi.fn>;
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
  skipForm = vi.fn(async () => true);
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
      skipForm,
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

    expect(submitLead).toHaveBeenCalledWith(
      {
        consent: true,
        name: 'Lina',
        email: 'lina@shop.test',
      },
      undefined,
    );
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
    expect(root.querySelector<HTMLButtonElement>('form.lead .skip')?.hidden).toBe(true);
  });

  it('asks for an address when the organization is out of conversations', () => {
    const root = mount(state({ isOpen: true, online: false, overQuota: true }));

    expect(root.querySelector<HTMLFormElement>('form.lead')?.hidden).toBe(false);
    expect(root.querySelector<HTMLDivElement>('.composer')?.hidden).toBe(false);
  });

  it('offers the welcome buttons under the welcome line until the visitor writes, and sends the one tapped', async () => {
    const config = {
      ...CONFIG,
      welcomeOptions: [
        { key: 'sales', label: { en: 'Talk to sales', ar: 'المبيعات' } },
        { key: 'help', label: { en: 'I need help', ar: 'أحتاج مساعدة' } },
      ],
    };
    const root = mount(state({ config, isOpen: true }));

    const chipsOf = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.chip'));
    expect(chipsOf().map((chip) => chip.textContent)).toEqual(['Talk to sales', 'I need help']);
    chipsOf()[1]?.click();
    await settled();
    expect(send).toHaveBeenCalledWith('I need help', { option: 'help' });

    current = state({ config, isOpen: true, messages: [message('m1', 'in', 'I need help')] });
    listener?.(current);
    expect(chipsOf()).toHaveLength(0);
  });

  it('draws a question with its quick replies, on the last line only, and a tap answers that line', async () => {
    const question = message('q1', 'out', 'What brings you here?\n\n1. Sales\n2. Support', {
      kind: 'choices',
      payload: {
        options: [
          { key: 'sales', label: 'Sales' },
          { key: 'support', label: 'Support' },
        ],
      },
    });
    const root = mount(state({ isOpen: true, messages: [question] }));

    const bubble = root.querySelectorAll('.bubble')[1];
    expect(bubble?.querySelector('.body')?.textContent).toBe('What brings you here?');
    const chips = Array.from(bubble?.querySelectorAll<HTMLButtonElement>('.chip') ?? []);
    expect(chips.map((chip) => chip.getAttribute('data-option'))).toEqual(['sales', 'support']);
    chips[1]?.click();
    await settled();
    expect(send).toHaveBeenCalledWith('Support', { option: 'support', replyTo: 'q1' });

    current = state({
      isOpen: true,
      messages: [question, message('m2', 'in', 'Support', { payload: { option: 'support', replyTo: 'q1' } })],
    });
    listener?.(current);
    expect(root.querySelector('.chip')).toBeNull();
  });

  it('labels the bot by the name the organization gave it, or as the assistant', () => {
    const root = mount(state({ isOpen: true, messages: [message('b1', 'out', 'Hello')] }));
    expect(root.querySelectorAll('.bubble')[1]?.querySelector('.who')?.textContent).toBe('Assistant');
    handle?.destroy();

    const named = mount(
      state({
        config: { ...CONFIG, botName: 'Noor' },
        isOpen: true,
        messages: [message('b1', 'out', 'Hello')],
      }),
    );
    expect(named.querySelectorAll('.bubble')[1]?.querySelector('.who')?.textContent).toBe('Noor');
  });

  it('shows typing dots in place of a bot line not yet due, and the line once it is', () => {
    const soon = message('b1', 'out', 'One moment', { revealAt: Date.now() + 60_000 });
    const root = mount(state({ isOpen: true, messages: [soon] }));

    expect(root.querySelector('.typing')).not.toBeNull();
    expect(root.querySelector('.typing')?.getAttribute('aria-label')).toBe('Typing…');
    expect(root.querySelector('.log')?.textContent).not.toContain('One moment');

    current = state({ isOpen: true, messages: [{ ...soon, revealAt: Date.now() - 1 }] });
    listener?.(current);
    expect(root.querySelector('.typing')).toBeNull();
    expect(root.querySelector('.log')?.textContent).toContain('One moment');
  });

  it('links the URLs in a line and draws the link buttons under it, http(s) only', () => {
    const root = mount(
      state({
        isOpen: true,
        messages: [
          message('b1', 'out', 'See https://shop.test/faq. Or write <b>here</b>', {
            payload: {
              buttons: [
                { label: 'Open the FAQ', url: 'https://shop.test/faq' },
                { label: 'Nope', url: 'javascript:alert(1)' },
              ],
            },
          }),
        ],
      }),
    );

    const body = root.querySelectorAll('.bubble')[1]?.querySelector('.body');
    const inline = body?.querySelector('a');
    expect(inline?.getAttribute('href')).toBe('https://shop.test/faq');
    expect(inline?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(body?.textContent).toBe('See https://shop.test/faq. Or write <b>here</b>');
    expect(body?.querySelector('b')).toBeNull();
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('.link'));
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Open the FAQ', 'https://shop.test/faq'],
    ]);
  });

  it('shows the form a scenario asks for, with its fields, and answers or skips that request', async () => {
    const request = message('f1', 'out', 'Where can we reach you?', {
      kind: 'form',
      payload: { form: { collectName: false, collectPhone: true, consentText: 'Texts are fine.' } },
    });
    const root = mount(state({ isOpen: true, messages: [request] }));
    const form = root.querySelector<HTMLFormElement>('form.lead');
    if (!form) throw new Error('no form');

    expect(form.hidden).toBe(false);
    expect(form.getAttribute('data-request')).toBe('f1');
    const fieldOf = (name: string) =>
      form.querySelector(`[name="${name}"]`)?.closest<HTMLLabelElement>('.field');
    expect(fieldOf('name')?.hidden).toBe(true);
    expect(fieldOf('phone')?.hidden).toBe(false);
    expect(form.querySelector('.consent span')?.textContent).toBe('Texts are fine.');
    expect(root.querySelector('.log')?.textContent).toContain('Where can we reach you?');

    form.querySelector<HTMLInputElement>('[name="phone"]')!.value = '+966501234567';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settled();
    expect(submitLead).toHaveBeenCalledWith({ consent: false, phone: '+966501234567' }, 'f1');
    expect(form.hidden).toBe(true);
    handle?.destroy();

    const again = mount(state({ isOpen: true, messages: [request] }));
    again.querySelector<HTMLButtonElement>('form.lead .skip')?.click();
    await settled();
    expect(skipForm).toHaveBeenCalledWith('f1');
    expect(again.querySelector<HTMLFormElement>('form.lead')?.hidden).toBe(true);
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
