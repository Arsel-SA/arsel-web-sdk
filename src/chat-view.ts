import * as chat from './chat';
import type { ChatFormRequest, ChatLead, ChatState, ChatWidgetConfig } from './chat-types';
import { CHAT_STRINGS, type ChatStrings } from './chat-strings';
import { applyChatStyles } from './chat-styles';
import { MESSAGE_MAX_LENGTH, buildElements, type Elements } from './chat-view-dom';
import { drawMessages, lastShown, type LinesContext } from './chat-view-lines';
import type { FileRefusal } from './chat-files';

/**
 * The chat widget's DOM: a launcher bubble and the window it opens, drawn
 * into a closed shadow root on a host appended to `document.body`, so the
 * host page's CSS cannot reach it and its CSS cannot leak out. The elements
 * are built in `chat-view-dom.ts` and the thread's lines in
 * `chat-view-lines.ts`; this wires them to the engine.
 */

const DEFAULT_Z_INDEX = 2_147_482_000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export interface ChatViewHandle {
  /** Internal test seam. Never re-exported from the public entry point. */
  readonly root: ShadowRoot;
  destroy(): void;
}

/** The form a scenario asked for, while it is the thread's last line and not yet answered. */
interface ActiveRequest {
  id: string;
  form: ChatFormRequest;
}

/** What the view remembers between draws: the visitor's own choices, which the engine does not keep. */
interface ViewMemory {
  leadFormShown: boolean;
  leadFormDone: boolean;
  /** Scenario form requests the visitor answered or skipped, by the request's line. */
  requestsDone: Set<string>;
  activeRequest: ActiveRequest | null;
  /** The welcome teaser's delay ran out. */
  welcomeDue: boolean;
  /** Dismissed, or the window was opened: no teaser again on this page. */
  teaserDone: boolean;
  ratings: Map<string, number>;
  comments: Map<string, string>;
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
  const memory: ViewMemory = {
    leadFormShown: false,
    leadFormDone: initial.identified,
    requestsDone: new Set<string>(),
    activeRequest: null,
    welcomeDue: false,
    teaserDone: false,
    ratings: new Map(),
    comments: new Map(),
  };

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
    const context: LinesContext = {
      state,
      config: current,
      locale,
      texts,
      strings,
      ratings: memory.ratings,
      comments: memory.comments,
      redraw: () => draw(chat.snapshot()),
    };
    keepingFocus(root, () => drawMessages(elements.log, context));
    drawForm(elements, current, texts, state, memory);
    elements.attachButton.hidden = !current.allowAttachments;
    elements.poweredBy.hidden = !current.poweredBy;
    if (state.isOpen) memory.teaserDone = true;
    drawTeaser(elements, texts, state, memory);
    if (state.isOpen) elements.log.scrollTop = elements.log.scrollHeight;
  };

  const detach = wire(elements, strings, memory, () => draw(chat.snapshot()));

  const teaserTimer =
    config.welcomeDelaySeconds >= 0
      ? setTimeout(() => {
          memory.welcomeDue = true;
          draw(chat.snapshot());
        }, config.welcomeDelaySeconds * 1000)
      : null;

  const unsubscribe = chat.subscribe(draw);
  document.body.append(host);
  draw(initial);

  return {
    root,
    destroy: () => {
      unsubscribe();
      if (teaserTimer) clearTimeout(teaserTimer);
      detach();
      host.remove();
    },
  };
}

/** The visitor's controls, forwarded to the engine. Returns what undoes the page-level listener. */
function wire(
  elements: Elements,
  strings: ChatStrings,
  memory: ViewMemory,
  redraw: () => void,
): () => void {
  const openChat = () => void chat.open().then(() => elements.input.focus());
  elements.launcher.addEventListener('click', () => {
    if (chat.snapshot().isOpen) {
      chat.close();
      elements.launcher.focus();
    } else {
      openChat();
    }
  });
  elements.sendButton.addEventListener('click', () => void submit(elements));
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit(elements);
    }
  });
  elements.input.addEventListener('input', () => {
    showFileRefusal(elements, strings, null);
    chat.noteTyping();
  });
  elements.attachButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files?.[0];
    elements.fileInput.value = '';
    if (!file) return;
    showFileRefusal(elements, strings, null);
    void chat.sendFile(file).then((refusal) => showFileRefusal(elements, strings, refusal));
  });
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const request = memory.activeRequest;
    void submitLead(elements, strings, request).then((done) => {
      if (!done) return;
      if (request) memory.requestsDone.add(request.id);
      else memory.leadFormDone = true;
      redraw();
      elements.input.focus();
    });
  });
  elements.formSkip.addEventListener('click', () => {
    const request = memory.activeRequest;
    if (request) {
      memory.requestsDone.add(request.id);
      void chat.skipForm(request.id);
    } else {
      memory.leadFormDone = true;
    }
    redraw();
    elements.input.focus();
  });
  elements.teaserText.addEventListener('click', openChat);
  elements.teaserClose.addEventListener('click', () => {
    memory.teaserDone = true;
    chat.dismissProactive();
    redraw();
  });
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && chat.snapshot().isOpen) {
      chat.close();
      elements.launcher.focus();
    }
  };
  document.addEventListener('keydown', onEscape);
  return () => document.removeEventListener('keydown', onEscape);
}

/** The teaser above the launcher: a proactive message's words, or the welcome once its delay ran out. */
function drawTeaser(
  elements: Elements,
  texts: ChatWidgetConfig['texts']['en'],
  state: ChatState,
  memory: ViewMemory,
): void {
  const proactive = state.proactive?.display === 'teaser' ? state.proactive : null;
  elements.teaserText.textContent = proactive?.text ?? texts.welcome;
  elements.teaserClose.hidden = !proactive;
  elements.teaser.hidden =
    state.isOpen || memory.teaserDone || !(proactive || memory.welcomeDue);
}

function drawForm(
  elements: Elements,
  config: ChatWidgetConfig,
  texts: ChatWidgetConfig['texts']['en'],
  state: ChatState,
  memory: ViewMemory,
): void {
  memory.activeRequest = requestOf(state, memory.requestsDone);
  const askNow =
    memory.activeRequest !== null ||
    shouldAskForEmail(config, state, memory.leadFormDone, memory.leadFormShown);
  configureForm(elements, config, texts, memory.activeRequest);
  elements.form.hidden = !askNow;
  if (askNow && !memory.activeRequest) memory.leadFormShown = true;
  elements.composer.hidden =
    askNow && !memory.activeRequest && config.askForEmail === 'always';
}

/**
 * Draws the thread again without losing the visitor's place: the control
 * they were in, a quick reply or a rating's comment box, is focused again
 * after the log is rebuilt, with what they had selected.
 */
function keepingFocus(root: ShadowRoot, redraw: () => void): void {
  const focused = root.activeElement as HTMLElement | null;
  const key = focused?.dataset?.focusKey;
  const selection =
    focused instanceof HTMLTextAreaElement
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  redraw();
  if (!key) return;
  const again = [...root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
    (element) => element.dataset.focusKey === key,
  );
  if (!again) return;
  again.focus();
  if (selection && again instanceof HTMLTextAreaElement) {
    again.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
  }
}

function showFileRefusal(
  elements: Elements,
  strings: ChatStrings,
  refusal: FileRefusal | null,
): void {
  const text =
    refusal === 'too_large'
      ? strings.fileTooLarge
      : refusal === 'type'
        ? strings.fileType
        : refusal
          ? strings.fileFailed
          : '';
  elements.composerError.textContent = text;
  elements.composerError.hidden = text === '';
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

function readDirection(): string {
  const explicit = document.documentElement.getAttribute('dir');
  if (explicit) return explicit;
  try {
    return getComputedStyle(document.documentElement).direction || 'ltr';
  } catch {
    return 'ltr';
  }
}
