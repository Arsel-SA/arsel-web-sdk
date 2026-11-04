import * as chat from './chat';
import type { ChatLead, ChatMessage, ChatState, ChatWidgetConfig } from './chat';
import { CHAT_STRINGS, type ChatLocale, type ChatStrings } from './chat-strings';

/**
 * The chat widget's DOM: a launcher bubble and the window it opens, drawn
 * into a closed shadow root on a host appended to `document.body`, so the
 * host page's CSS cannot reach it and its CSS cannot leak out. Text is set
 * with `textContent` only: every string is either the organization's or a
 * visitor's, and renders on the customer's origin.
 */

const DEFAULT_Z_INDEX = 2_147_482_000;
const MOBILE_BREAKPOINT_PX = 480;
const MESSAGE_MAX_LENGTH = 2000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const BRAND_NAME = 'Arsel';
const BRAND_URL = 'https://arsel.sa';

let sheet: CSSStyleSheet | null = null;

export interface ChatViewHandle {
  /** Internal test seam. Never re-exported from the public entry point. */
  readonly root: ShadowRoot;
  destroy(): void;
}

interface Elements {
  host: HTMLDivElement;
  launcher: HTMLButtonElement;
  badge: HTMLSpanElement;
  teaser: HTMLDivElement;
  window: HTMLDivElement;
  title: HTMLSpanElement;
  presence: HTMLSpanElement;
  presenceDot: HTMLSpanElement;
  log: HTMLDivElement;
  form: HTMLFormElement;
  composer: HTMLDivElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  poweredBy: HTMLDivElement;
}

/**
 * Mounts the widget once and keeps it in step with the engine's state. The
 * engine owns every fact; this layer only draws and forwards what the
 * visitor does.
 */
export function mountChat(initial: ChatState, zIndex: number): ChatViewHandle {
  const config = initial.config;
  if (!config) throw new Error('mountChat needs a widget config');
  const locale = chat.resolveLocale(config);
  const strings = CHAT_STRINGS[locale];
  const texts = config.texts[locale];

  const host = document.createElement('div');
  host.setAttribute('data-arsel-chat', '');
  const root = host.attachShadow({ mode: 'closed' });
  applyStyles(root);
  host.style.setProperty('z-index', String(zIndex || DEFAULT_Z_INDEX));
  host.style.setProperty('isolation', 'isolate');
  host.setAttribute('dir', locale === 'ar' ? 'rtl' : readDirection());
  host.setAttribute('data-position', config.position);
  host.style.setProperty('--arsel-chat-primary', config.primaryColor);

  const elements = buildElements(root, config, strings, texts);
  let leadFormShown = false;
  let leadFormDone = initial.identified;
  let teaserTimer: ReturnType<typeof setTimeout> | null = null;

  const draw = (state: ChatState): void => {
    const current = state.config ?? config;
    elements.host.classList.toggle('open', state.isOpen);
    elements.launcher.setAttribute('aria-expanded', String(state.isOpen));
    elements.launcher.setAttribute('aria-label', state.isOpen ? strings.close : strings.open);
    elements.badge.textContent = state.unread > 0 ? String(state.unread) : '';
    elements.badge.hidden = state.unread === 0;
    elements.title.textContent = current.name;
    elements.presence.textContent = state.online ? strings.online : strings.away;
    elements.presenceDot.classList.toggle('online', state.online);
    drawMessages(elements.log, state, texts, strings);
    const askNow = shouldAskForEmail(current, state, leadFormDone, leadFormShown);
    elements.form.hidden = !askNow;
    if (askNow) leadFormShown = true;
    elements.composer.hidden = askNow && current.askForEmail === 'always';
    elements.poweredBy.hidden = !current.poweredBy;
    if (state.isOpen) {
      elements.log.scrollTop = elements.log.scrollHeight;
      if (teaserTimer) clearTimeout(teaserTimer);
      elements.teaser.hidden = true;
    }
  };

  elements.launcher.addEventListener('click', () => {
    if (chat.snapshot().isOpen) {
      chat.close();
      elements.launcher.focus();
    } else {
      void chat.open().then(() => elements.input.focus());
    }
  });
  elements.sendButton.addEventListener('click', () => void submit(elements));
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit(elements);
    }
  });
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && chat.snapshot().isOpen) {
      chat.close();
      elements.launcher.focus();
    }
  };
  document.addEventListener('keydown', onEscape);
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitLead(elements.form, config, strings).then((done) => {
      if (done) {
        leadFormDone = true;
        draw(chat.snapshot());
        elements.input.focus();
      }
    });
  });
  const skip = elements.form.querySelector<HTMLButtonElement>('.skip');
  skip?.addEventListener('click', () => {
    leadFormDone = true;
    draw(chat.snapshot());
    elements.input.focus();
  });
  elements.teaser.addEventListener('click', () => void chat.open());

  if (config.welcomeDelaySeconds >= 0) {
    teaserTimer = setTimeout(() => {
      if (!chat.snapshot().isOpen) elements.teaser.hidden = false;
    }, config.welcomeDelaySeconds * 1000);
  }

  const unsubscribe = chat.subscribe(draw);
  document.body.append(host);
  draw(initial);

  return {
    root,
    destroy: () => {
      unsubscribe();
      if (teaserTimer) clearTimeout(teaserTimer);
      document.removeEventListener('keydown', onEscape);
      host.remove();
    },
  };
}

/**
 * When the lead form shows: before anything for `always`; after the first
 * message for `before_human`; and whenever the team is away and the
 * visitor has written, so a lead is not lost. Never twice, never once the
 * visitor is identified.
 */
function shouldAskForEmail(
  config: ChatWidgetConfig,
  state: ChatState,
  done: boolean,
  shown: boolean,
): boolean {
  if (done) return false;
  const wrote = state.messages.some((m) => m.direction === 'in' && !m.pending);
  if (config.askForEmail === 'always') return true;
  if (shown) return true;
  if (config.askForEmail === 'before_human') return wrote;
  return wrote && !state.online;
}

async function submit(elements: Elements): Promise<void> {
  const text = elements.input.value.trim();
  if (!text) return;
  elements.input.value = '';
  elements.input.focus();
  await chat.send(text.slice(0, MESSAGE_MAX_LENGTH));
}

async function submitLead(
  form: HTMLFormElement,
  config: ChatWidgetConfig,
  strings: ChatStrings,
): Promise<boolean> {
  const field = (name: string) =>
    form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? '';
  const error = form.querySelector<HTMLParagraphElement>('.error');
  const email = field('email');
  const phone = field('phone');
  const lead: ChatLead = {
    consent: form.querySelector<HTMLInputElement>('[name="consent"]')?.checked ?? false,
    ...(config.collect.name && field('name') ? { name: field('name') } : {}),
    ...(email ? { email } : {}),
    ...(config.collect.phone && phone ? { phone } : {}),
  };
  if (!email && !phone) {
    if (error) error.textContent = strings.invalidEmail;
    return false;
  }
  if (email && !EMAIL_SHAPE.test(email)) {
    if (error) error.textContent = strings.invalidEmail;
    return false;
  }
  if (phone && !E164.test(phone)) {
    if (error) error.textContent = strings.invalidPhone;
    return false;
  }
  if (error) error.textContent = '';
  return chat.submitLead(lead);
}

function drawMessages(
  log: HTMLDivElement,
  state: ChatState,
  texts: ChatWidgetConfig['texts']['en'],
  strings: ChatStrings,
): void {
  log.replaceChildren();
  log.append(bubble({ text: texts.welcome, side: 'team', sender: null, strings }));
  for (const message of state.messages) {
    if (message.kind === 'notice') {
      const notice = document.createElement('div');
      notice.className = 'notice';
      notice.textContent = message.text ?? '';
      log.append(notice);
      continue;
    }
    const side = message.direction === 'in' ? 'you' : 'team';
    const node = bubble({
      text: message.text ?? '',
      side,
      sender: message.sender.kind === 'agent' ? message.sender.name : null,
      strings,
    });
    if (message.pending === 'sending') node.classList.add('pending');
    if (message.pending === 'failed') {
      node.classList.add('failed');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = `${strings.failed} ${strings.retry}`;
      retry.addEventListener('click', () => {
        void chat.send(message.text ?? '', message.clientMessageId);
      });
      node.append(retry);
    }
    log.append(node);
  }
}

function bubble(args: {
  text: string;
  side: 'you' | 'team';
  sender: string | null;
  strings: ChatStrings;
}): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = `bubble ${args.side}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent =
    args.side === 'you' ? args.strings.you : (args.sender ?? args.strings.team);
  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = args.text;
  wrap.append(who, body);
  return wrap;
}

function buildElements(
  root: ShadowRoot,
  config: ChatWidgetConfig,
  strings: ChatStrings,
  texts: ChatWidgetConfig['texts']['en'],
): Elements {
  const host = root.host as HTMLDivElement;

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.setAttribute('aria-label', strings.open);
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.append(icon());
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;
  launcher.append(badge);

  const teaser = document.createElement('div');
  teaser.className = 'teaser';
  teaser.setAttribute('role', 'status');
  teaser.textContent = texts.welcome;
  teaser.hidden = true;

  const windowEl = document.createElement('div');
  windowEl.className = 'window';
  windowEl.setAttribute('role', 'dialog');
  windowEl.setAttribute('aria-label', config.name);

  const header = document.createElement('div');
  header.className = 'header';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = config.name;
  const presenceWrap = document.createElement('span');
  presenceWrap.className = 'presence';
  const presenceDot = document.createElement('span');
  presenceDot.className = 'dot';
  const presence = document.createElement('span');
  presenceWrap.append(presenceDot, presence);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'close';
  closeButton.setAttribute('aria-label', strings.close);
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => {
    chat.close();
    launcher.focus();
  });
  const titles = document.createElement('div');
  titles.className = 'titles';
  titles.append(title, presenceWrap);
  header.append(titles, closeButton);

  const log = document.createElement('div');
  log.className = 'log';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const form = buildLeadForm(config, strings, texts);

  const composer = document.createElement('div');
  composer.className = 'composer';
  const input = document.createElement('textarea');
  input.className = 'input';
  input.rows = 1;
  input.maxLength = MESSAGE_MAX_LENGTH;
  input.placeholder = texts.placeholder;
  input.setAttribute('aria-label', texts.placeholder);
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'send';
  sendButton.textContent = strings.send;
  composer.append(input, sendButton);

  const poweredBy = document.createElement('div');
  poweredBy.className = 'powered';
  const link = document.createElement('a');
  link.href = BRAND_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = BRAND_NAME;
  poweredBy.append(`${strings.poweredBy} `, link);

  windowEl.append(header, log, form, composer, poweredBy);
  root.append(teaser, launcher, windowEl);

  return {
    host,
    launcher,
    badge,
    teaser,
    window: windowEl,
    title,
    presence,
    presenceDot,
    log,
    form,
    composer,
    input,
    sendButton,
    poweredBy,
  };
}

function buildLeadForm(
  config: ChatWidgetConfig,
  strings: ChatStrings,
  texts: ChatWidgetConfig['texts']['en'],
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'lead';
  form.hidden = true;
  form.setAttribute('aria-label', texts.offlineForm);
  const intro = document.createElement('p');
  intro.className = 'intro';
  intro.textContent = texts.offlineForm;
  form.append(intro);
  const field = (name: string, label: string, type: string): void => {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    input.setAttribute('autocomplete', name);
    wrap.append(text, input);
    form.append(wrap);
  };
  if (config.collect.name) field('name', strings.name, 'text');
  field('email', strings.email, 'email');
  if (config.collect.phone) field('phone', strings.phone, 'tel');
  const consent = document.createElement('label');
  consent.className = 'consent';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.name = 'consent';
  const consentText = document.createElement('span');
  consentText.textContent = texts.leadConsent;
  consent.append(box, consentText);
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'submit';
  submit.textContent = strings.submit;
  actions.append(submit);
  if (config.askForEmail !== 'always') {
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'skip';
    skip.textContent = strings.skip;
    actions.append(skip);
  }
  form.append(consent, error, actions);
  return form;
}

function icon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  );
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function readDirection(): string {
  const explicit = document.documentElement.getAttribute('dir');
  if (explicit) return explicit;
  try {
    return getComputedStyle(document.documentElement).direction || 'ltr';
  } catch {
    return 'ltr';
  }
}

/** The locale the widget drew in, for tests of the strings it shows. */
export function stringsFor(locale: ChatLocale): ChatStrings {
  return CHAT_STRINGS[locale];
}

/**
 * A constructed stylesheet rather than a `<style>` element wherever possible:
 * a `<style>` inside a shadow root is governed by the host page's
 * `style-src`, a constructed sheet is not. The fallback stays for browsers
 * without `adoptedStyleSheets`, and is the branch most test DOMs take.
 */
function applyStyles(root: ShadowRoot): void {
  if ('adoptedStyleSheets' in Document.prototype && typeof CSSStyleSheet === 'function') {
    try {
      sheet ??= buildSheet();
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Constructable stylesheets unavailable despite the feature test.
    }
  }
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  root.append(style);
}

function buildSheet(): CSSStyleSheet {
  const constructed = new CSSStyleSheet();
  constructed.replaceSync(CSS_TEXT);
  return constructed;
}

const CSS_TEXT = `
:host {
  all: initial;
  position: fixed;
  inset-block-end: 20px;
  inset-inline-end: 20px;
  display: block;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif;
  font-size: 15px;
  line-height: 1.45;
  color: #0f172a;
  --arsel-chat-primary: #2563eb;
}
:host([data-position="left"]) { inset-inline-end: auto; inset-inline-start: 20px; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; cursor: pointer; }
.launcher {
  position: relative;
  width: 56px; height: 56px;
  border: 0; border-radius: 50%;
  background: var(--arsel-chat-primary); color: #fff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.25);
  display: grid; place-items: center;
  transition: transform 120ms ease;
}
.launcher:hover { transform: scale(1.05); }
.launcher:focus-visible { outline: 3px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 5px var(--arsel-chat-primary); }
.badge {
  position: absolute; inset-block-start: -4px; inset-inline-end: -4px;
  min-width: 22px; height: 22px; padding: 0 6px;
  border-radius: 11px; background: #dc2626; color: #fff;
  font-size: 12px; font-weight: 600; line-height: 22px; text-align: center;
}
.teaser {
  position: absolute; inset-block-end: 68px; inset-inline-end: 0;
  max-width: 280px; padding: 12px 14px;
  background: #fff; color: #0f172a; border-radius: 14px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  cursor: pointer; font-size: 14px;
}
:host([data-position="left"]) .teaser { inset-inline-end: auto; inset-inline-start: 0; }
.window {
  position: absolute; inset-block-end: 72px; inset-inline-end: 0;
  width: 380px; max-width: calc(100vw - 40px); height: 560px; max-height: calc(100vh - 112px);
  display: none; flex-direction: column;
  background: #fff; border-radius: 16px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.25);
}
:host([data-position="left"]) .window { inset-inline-end: auto; inset-inline-start: 0; }
:host(.open) .window { display: flex; }
.header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; background: var(--arsel-chat-primary); color: #fff;
}
.titles { display: flex; flex-direction: column; min-width: 0; }
.title { font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.presence { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.9; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
.dot.online { background: #22c55e; }
.close {
  width: 36px; height: 36px; border: 0; border-radius: 50%;
  background: rgba(255, 255, 255, 0.18); color: #fff; font-size: 22px; line-height: 1;
}
.close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.log {
  flex: 1; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 10px; background: #f8fafc;
}
.bubble { display: flex; flex-direction: column; gap: 2px; max-width: 85%; }
.bubble.team { align-self: flex-start; }
.bubble.you { align-self: flex-end; }
.who { font-size: 11px; color: #64748b; padding: 0 4px; }
.body {
  margin: 0; padding: 10px 14px; border-radius: 16px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}
.bubble.team .body { border-start-start-radius: 4px; }
.bubble.you .body { background: var(--arsel-chat-primary); color: #fff; border-start-end-radius: 4px; }
.bubble.pending .body { opacity: 0.6; }
.bubble.failed .body { background: #fee2e2; color: #991b1b; }
.retry { align-self: flex-end; border: 0; background: none; color: #991b1b; font-size: 12px; text-decoration: underline; padding: 2px 4px; }
.notice { align-self: center; font-size: 13px; color: #475569; text-align: center; padding: 4px 8px; }
.lead { padding: 12px 16px; border-top: 1px solid #e2e8f0; display: flex; flex-direction: column; gap: 8px; background: #fff; }
.lead .intro { margin: 0; font-size: 14px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #334155; }
.field input, .input {
  font: inherit; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 10px; color: #0f172a; background: #fff;
}
.field input:focus, .input:focus { outline: 2px solid var(--arsel-chat-primary); outline-offset: 1px; border-color: transparent; }
.consent { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: #334155; }
.consent input { margin-block-start: 3px; }
.error { margin: 0; min-height: 1em; font-size: 12px; color: #b91c1c; }
.actions { display: flex; gap: 8px; }
.submit { border: 0; border-radius: 10px; padding: 8px 14px; background: var(--arsel-chat-primary); color: #fff; font-weight: 600; }
.skip { border: 0; border-radius: 10px; padding: 8px 14px; background: #f1f5f9; color: #334155; }
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #fff; }
.input { flex: 1; resize: none; min-height: 40px; max-height: 120px; }
.send { border: 0; border-radius: 10px; padding: 10px 16px; background: var(--arsel-chat-primary); color: #fff; font-weight: 600; min-height: 40px; }
.send:focus-visible, .submit:focus-visible, .skip:focus-visible, .retry:focus-visible { outline: 2px solid var(--arsel-chat-primary); outline-offset: 2px; }
.powered { padding: 6px 16px 10px; font-size: 11px; color: #94a3b8; text-align: center; background: #fff; }
.powered a { color: inherit; text-decoration: underline; }
[hidden] { display: none !important; }
@media (max-width: ${MOBILE_BREAKPOINT_PX}px) {
  :host(.open) { inset: 0; }
  :host(.open) .launcher, :host(.open) .teaser { display: none; }
  .window { position: fixed; inset: 0; width: auto; max-width: none; height: auto; max-height: none; border-radius: 0; }
}
`;
