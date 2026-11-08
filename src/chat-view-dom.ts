import * as chat from './chat';
import { ATTACHMENT_TYPES } from './chat-files';
import type { ChatStrings } from './chat-strings';
import type { ChatWidgetConfig } from './chat-types';

/**
 * The widget's elements, built once: the launcher, the teaser above it, and
 * the window with its header, thread, forms and composer. `chat-view.ts`
 * wires them; `chat-view-lines.ts` fills the thread.
 */

export const MESSAGE_MAX_LENGTH = 2000;
const BRAND_NAME = 'Arsel';
const BRAND_URL = 'https://arsel.sa';
const SVG_NS = 'http://www.w3.org/2000/svg';
const CHAT_ICON =
  'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
const PAPERCLIP_ICON =
  'M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5h-1.5v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10z';

export interface Elements {
  host: HTMLDivElement;
  launcher: HTMLButtonElement;
  badge: HTMLSpanElement;
  teaser: HTMLDivElement;
  teaserText: HTMLButtonElement;
  teaserClose: HTMLButtonElement;
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
  attachButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  composerError: HTMLParagraphElement;
  sendButton: HTMLButtonElement;
  poweredBy: HTMLDivElement;
}

export function buildElements(
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
  launcher.append(icon(CHAT_ICON, 26));
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;
  launcher.append(badge);

  const teaser = buildTeaser(strings, texts);

  const windowEl = document.createElement('div');
  windowEl.className = 'window';
  windowEl.setAttribute('role', 'dialog');
  windowEl.setAttribute('aria-label', config.name);

  const header = buildHeader(config, strings, launcher);

  const log = document.createElement('div');
  log.className = 'log';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const lead = buildLeadForm(strings, texts);
  const composer = buildComposer(strings, texts);

  const poweredBy = document.createElement('div');
  poweredBy.className = 'powered';
  const link = document.createElement('a');
  link.href = BRAND_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = BRAND_NAME;
  poweredBy.append(`${strings.poweredBy} `, link);

  windowEl.append(header.element, log, lead.form, composer.error, composer.element, poweredBy);
  root.append(teaser.element, launcher, windowEl);

  return {
    host,
    launcher,
    badge,
    teaser: teaser.element,
    teaserText: teaser.text,
    teaserClose: teaser.close,
    window: windowEl,
    title: header.title,
    presence: header.presence,
    presenceDot: header.presenceDot,
    log,
    form: lead.form,
    formIntro: lead.intro,
    formFields: lead.fields,
    formConsent: lead.consent,
    formSkip: lead.skip,
    composer: composer.element,
    input: composer.input,
    attachButton: composer.attach,
    fileInput: composer.file,
    composerError: composer.error,
    sendButton: composer.send,
    poweredBy,
  };
}

/** The bubble above the launcher: the welcome, or a proactive message, which can be dismissed. */
function buildTeaser(
  strings: ChatStrings,
  texts: ChatWidgetConfig['texts']['en'],
): { element: HTMLDivElement; text: HTMLButtonElement; close: HTMLButtonElement } {
  const element = document.createElement('div');
  element.className = 'teaser';
  element.setAttribute('role', 'status');
  element.hidden = true;
  const text = document.createElement('button');
  text.type = 'button';
  text.className = 'teaser-text';
  text.textContent = texts.welcome;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'teaser-close';
  close.setAttribute('aria-label', strings.dismiss);
  close.textContent = '×';
  element.append(text, close);
  return { element, text, close };
}

function buildHeader(
  config: ChatWidgetConfig,
  strings: ChatStrings,
  launcher: HTMLButtonElement,
): {
  element: HTMLDivElement;
  title: HTMLSpanElement;
  presence: HTMLSpanElement;
  presenceDot: HTMLSpanElement;
} {
  const element = document.createElement('div');
  element.className = 'header';
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
  element.append(titles, closeButton);
  return { element, title, presence, presenceDot };
}

function buildComposer(
  strings: ChatStrings,
  texts: ChatWidgetConfig['texts']['en'],
): {
  element: HTMLDivElement;
  input: HTMLTextAreaElement;
  attach: HTMLButtonElement;
  file: HTMLInputElement;
  error: HTMLParagraphElement;
  send: HTMLButtonElement;
} {
  const element = document.createElement('div');
  element.className = 'composer';
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.className = 'attach';
  attach.setAttribute('aria-label', strings.attach);
  attach.title = strings.attach;
  attach.append(icon(PAPERCLIP_ICON, 20));
  attach.hidden = true;
  const file = document.createElement('input');
  file.type = 'file';
  file.className = 'file-input';
  file.accept = ATTACHMENT_TYPES.join(',');
  file.hidden = true;
  file.tabIndex = -1;
  file.setAttribute('aria-hidden', 'true');
  const input = document.createElement('textarea');
  input.className = 'input';
  input.rows = 1;
  input.maxLength = MESSAGE_MAX_LENGTH;
  input.placeholder = texts.placeholder;
  input.setAttribute('aria-label', texts.placeholder);
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'send';
  send.textContent = strings.send;
  element.append(attach, file, input, send);
  const error = document.createElement('p');
  error.className = 'composer-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  return { element, input, attach, file, error, send };
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

function icon(path: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const shape = document.createElementNS(SVG_NS, 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', 'currentColor');
  svg.append(shape);
  return svg;
}
