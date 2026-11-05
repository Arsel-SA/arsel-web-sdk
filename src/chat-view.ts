import * as chat from './chat';
import type {
  ChatFormRequest,
  ChatLead,
  ChatMessage,
  ChatState,
  ChatWidgetConfig,
} from './chat-types';
import { CHAT_STRINGS, type ChatLocale, type ChatStrings } from './chat-strings';
import { applyChatStyles } from './chat-styles';

/**
 * The chat widget's DOM: a launcher bubble and the window it opens, drawn
 * into a closed shadow root on a host appended to `document.body`, so the
 * host page's CSS cannot reach it and its CSS cannot leak out. Text is set
 * with `textContent` only: every string is either the organization's or a
 * visitor's, and renders on the customer's origin. The only markup built
 * from content is a link, and only around an `http(s)` URL.
 */

const DEFAULT_Z_INDEX = 2_147_482_000;
const MESSAGE_MAX_LENGTH = 2000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
/** Punctuation a sentence leaves after a URL is not part of it. */
const URL_TRAILING = /[.,;:!?)\]]+$/;
const BRAND_NAME = 'Arsel';
const BRAND_URL = 'https://arsel.sa';

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
  formIntro: HTMLParagraphElement;
  formFields: Record<'name' | 'email' | 'phone', HTMLLabelElement>;
  formConsent: HTMLSpanElement;
  formSkip: HTMLButtonElement;
  composer: HTMLDivElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  poweredBy: HTMLDivElement;
}

/** The form a scenario asked for, while it is the thread's last line and not yet answered. */
interface ActiveRequest {
  id: string;
  form: ChatFormRequest;
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
  applyChatStyles(root);
  host.style.setProperty('z-index', String(zIndex || DEFAULT_Z_INDEX));
  host.style.setProperty('isolation', 'isolate');
  host.setAttribute('dir', locale === 'ar' ? 'rtl' : readDirection());
  host.setAttribute('data-position', config.position);
  host.style.setProperty('--arsel-chat-primary', config.primaryColor);

  const elements = buildElements(root, config, strings, texts);
  let leadFormShown = false;
  let leadFormDone = initial.identified;
  /** Scenario form requests the visitor answered or skipped, by the request's line. */
  const requestsDone = new Set<string>();
  let activeRequest: ActiveRequest | null = null;
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
    drawMessages(elements.log, state, current, locale, texts, strings);
    activeRequest = requestOf(state, requestsDone);
    const askNow =
      activeRequest !== null ||
      shouldAskForEmail(current, state, leadFormDone, leadFormShown);
    configureForm(elements, current, texts, activeRequest);
    elements.form.hidden = !askNow;
    if (askNow && !activeRequest) leadFormShown = true;
    elements.composer.hidden = askNow && !activeRequest && current.askForEmail === 'always';
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
    const request = activeRequest;
    void submitLead(elements, strings, request).then((done) => {
      if (!done) return;
      if (request) requestsDone.add(request.id);
      else leadFormDone = true;
      draw(chat.snapshot());
      elements.input.focus();
    });
  });
  elements.formSkip.addEventListener('click', () => {
    const request = activeRequest;
    if (request) {
      requestsDone.add(request.id);
      void chat.skipForm(request.id);
    } else {
      leadFormDone = true;
    }
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
 * When the widget's own lead form shows: before anything for `always`;
 * after the first message for `before_human`; whenever the team is away
 * and the visitor has written, so a lead is not lost; and when the
 * organization is out of conversations. Never twice, never once the
 * visitor is identified.
 */
function shouldAskForEmail(
  config: ChatWidgetConfig,
  state: ChatState,
  done: boolean,
  shown: boolean,
): boolean {
  if (done) return false;
  if (state.overQuota) return true;
  const wrote = state.messages.some((m) => m.direction === 'in' && !m.pending);
  if (config.askForEmail === 'always') return true;
  if (shown) return true;
  if (config.askForEmail === 'before_human') return wrote;
  return wrote && !state.online;
}

/** The form a scenario asked for, if it is the last line and nothing answered it. */
function requestOf(state: ChatState, done: Set<string>): ActiveRequest | null {
  const last = lastShown(state);
  if (!last || last.kind !== 'form' || last.direction !== 'out') return null;
  if (!last.payload?.form || done.has(last.id)) return null;
  return { id: last.id, form: last.payload.form };
}

/** The last line the visitor can see: a bot line still "typing" is not there yet. */
function lastShown(state: ChatState): ChatMessage | null {
  const now = Date.now();
  const shown = state.messages.filter((m) => !(m.revealAt && m.revealAt > now));
  return shown[shown.length - 1] ?? null;
}

/** The form's fields and texts: the scenario's request, or the widget's own offline form. */
function configureForm(
  elements: Elements,
  config: ChatWidgetConfig,
  texts: ChatWidgetConfig['texts']['en'],
  request: ActiveRequest | null,
): void {
  const form = request?.form;
  elements.formIntro.textContent = request ? '' : texts.offlineForm;
  elements.formIntro.hidden = request !== null;
  elements.formFields.name.hidden = !(form ? form.collectName : config.collect.name);
  elements.formFields.phone.hidden = !(form ? form.collectPhone : config.collect.phone);
  elements.formConsent.textContent = form?.consentText ?? texts.leadConsent;
  elements.formSkip.hidden = !request && config.askForEmail === 'always';
  elements.form.setAttribute('data-request', request?.id ?? '');
}

async function submit(elements: Elements): Promise<void> {
  const text = elements.input.value.trim();
  if (!text) return;
  elements.input.value = '';
  elements.input.focus();
  await chat.send(text.slice(0, MESSAGE_MAX_LENGTH));
}

async function submitLead(
  elements: Elements,
  strings: ChatStrings,
  request: ActiveRequest | null,
): Promise<boolean> {
  const { form } = elements;
  const field = (name: 'name' | 'email' | 'phone') =>
    elements.formFields[name].hidden
      ? ''
      : (form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? '');
  const error = form.querySelector<HTMLParagraphElement>('.error');
  const email = field('email');
  const phone = field('phone');
  const name = field('name');
  const lead: ChatLead = {
    consent: form.querySelector<HTMLInputElement>('[name="consent"]')?.checked ?? false,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
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
  return chat.submitLead(lead, request?.id);
}

function drawMessages(
  log: HTMLDivElement,
  state: ChatState,
  config: ChatWidgetConfig,
  locale: ChatLocale,
  texts: ChatWidgetConfig['texts']['en'],
  strings: ChatStrings,
): void {
  log.replaceChildren();
  const welcome = bubble({ text: texts.welcome, side: 'team', who: strings.team });
  if (state.messages.length === 0) {
    const options = (config.welcomeOptions ?? []).filter((option) => option.label[locale]);
    if (options.length > 0) {
      welcome.append(
        chips(
          options.map((option) => ({ key: option.key, label: option.label[locale] })),
          (option) => void chat.send(option.label, { option: option.key }),
        ),
      );
    }
  }
  log.append(welcome);
  const now = Date.now();
  const last = lastShown(state);
  for (const message of state.messages) {
    if (message.revealAt && message.revealAt > now) {
      // The dots stand for every line still to come; the rest show one by one.
      log.append(typing(strings, config));
      break;
    }
    if (message.kind === 'notice') {
      const notice = document.createElement('div');
      notice.className = 'notice';
      notice.textContent = message.text ?? '';
      log.append(notice);
      continue;
    }
    const side = message.direction === 'in' ? 'you' : 'team';
    const node = bubble({
      text: bodyOf(message),
      side,
      who: whoOf(message, config, strings),
    });
    if (message.sender.kind === 'bot') node.classList.add('bot');
    const buttons = (message.payload?.buttons ?? []).filter((button) => isHttpUrl(button.url));
    if (buttons.length > 0) node.append(links(buttons));
    if (message === last && message.kind === 'choices' && message.payload?.options?.length) {
      node.append(
        chips(message.payload.options, (option) => {
          void chat.send(option.label, { option: option.key, replyTo: message.id });
        }),
      );
    }
    if (message.pending === 'sending') node.classList.add('pending');
    if (message.pending === 'failed') {
      node.classList.add('failed');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = `${strings.failed} ${strings.retry}`;
      retry.addEventListener('click', () => {
        void chat.send(message.text ?? '', {
          retryOf: message.clientMessageId,
          option: message.payload?.option,
          replyTo: message.payload?.replyTo,
        });
      });
      node.append(retry);
    }
    log.append(node);
  }
}

/** Who a line is from, as the label above it reads. */
function whoOf(message: ChatMessage, config: ChatWidgetConfig, strings: ChatStrings): string {
  switch (message.sender.kind) {
    case 'visitor':
      return strings.you;
    case 'agent':
      return message.sender.name ?? strings.team;
    case 'bot':
      return config.botName?.trim() || strings.bot;
    default:
      return strings.team;
  }
}

/**
 * A question's line carries its options numbered under the prompt, for a
 * widget that cannot draw quick replies; this one can, so the prompt alone
 * is shown when the numbering is exactly the options'.
 */
function bodyOf(message: ChatMessage): string {
  const text = message.text ?? '';
  const options = message.payload?.options;
  if (message.kind !== 'choices' || !options?.length) return text;
  const numbered = options.map((option, index) => `${index + 1}. ${option.label}`).join('\n');
  const suffix = `\n\n${numbered}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function bubble(args: { text: string; side: 'you' | 'team'; who: string }): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = `bubble ${args.side}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = args.who;
  const body = document.createElement('p');
  body.className = 'body';
  body.append(...linkified(args.text));
  wrap.append(who, body);
  return wrap;
}

/** The text as nodes: plain text, with each `http(s)` URL as a link that opens in a new tab. */
function linkified(text: string): (Text | HTMLAnchorElement)[] {
  const nodes: (Text | HTMLAnchorElement)[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    const url = match[0].replace(URL_TRAILING, '');
    if (start > cursor) nodes.push(document.createTextNode(text.slice(cursor, start)));
    nodes.push(anchor(url, url));
    cursor = start + url.length;
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
  return nodes;
}

function anchor(url: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  return link;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The links under a bot's line. */
function links(buttons: { label: string; url: string }[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'links';
  for (const button of buttons) {
    const link = anchor(button.url, button.label);
    link.className = 'link';
    row.append(link);
  }
  return row;
}

/** Quick replies: one tap sends the label. */
function chips(
  options: { key: string; label: string }[],
  onTap: (option: { key: string; label: string }) => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'chips';
  row.setAttribute('role', 'group');
  for (const option of options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.setAttribute('data-option', option.key);
    chip.textContent = option.label;
    chip.addEventListener('click', () => onTap(option));
    row.append(chip);
  }
  return row;
}

/** The dots a bot's line shows behind before it appears. */
function typing(strings: ChatStrings, config: ChatWidgetConfig): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bubble team typing';
  wrap.setAttribute('aria-label', strings.typing);
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = config.botName?.trim() || strings.bot;
  const body = document.createElement('p');
  body.className = 'body dots';
  for (let i = 0; i < 3; i += 1) body.append(document.createElement('span'));
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

  const lead = buildLeadForm(strings, texts);

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

  windowEl.append(header, log, lead.form, composer, poweredBy);
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
    form: lead.form,
    formIntro: lead.intro,
    formFields: lead.fields,
    formConsent: lead.consent,
    formSkip: lead.skip,
    composer,
    input,
    sendButton,
    poweredBy,
  };
}

interface LeadForm {
  form: HTMLFormElement;
  intro: HTMLParagraphElement;
  fields: Record<'name' | 'email' | 'phone', HTMLLabelElement>;
  consent: HTMLSpanElement;
  skip: HTMLButtonElement;
}

/** Every field the widget or a scenario may ask for; `configureForm` shows the ones asked. */
function buildLeadForm(strings: ChatStrings, texts: ChatWidgetConfig['texts']['en']): LeadForm {
  const form = document.createElement('form');
  form.className = 'lead';
  form.hidden = true;
  form.setAttribute('aria-label', texts.offlineForm);
  const intro = document.createElement('p');
  intro.className = 'intro';
  intro.textContent = texts.offlineForm;
  form.append(intro);
  const field = (name: 'name' | 'email' | 'phone', label: string, type: string) => {
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
    return wrap;
  };
  const fields = {
    name: field('name', strings.name, 'text'),
    email: field('email', strings.email, 'email'),
    phone: field('phone', strings.phone, 'tel'),
  };
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
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'skip';
  skip.textContent = strings.skip;
  actions.append(submit, skip);
  form.append(consent, error, actions);
  return { form, intro, fields, consent: consentText, skip };
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
