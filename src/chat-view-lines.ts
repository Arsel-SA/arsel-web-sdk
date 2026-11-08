import * as chat from './chat';
import type { ChatLocale, ChatStrings } from './chat-strings';
import type { ChatAttachment, ChatMessage, ChatState, ChatWidgetConfig } from './chat-types';

/**
 * The thread's lines as nodes. Text is set with `textContent` only: every
 * string is either the organization's or a visitor's, and renders on the
 * customer's origin. The only markup built from content is a link or an
 * image, and only around an `http(s)` URL.
 */

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
/** Punctuation a sentence leaves after a URL is not part of it. */
const URL_TRAILING = /[.,;:!?)\]]+$/;
const RATING_FACES = ['😞', '🙁', '😐', '🙂', '😄'];
const RATING_COMMENT_MAX_LENGTH = 1000;
const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * KILOBYTE;
/** Within this many pixels of the end, the log still counts as read to its end. */
const NEAR_END_PX = 80;

/** Everything a line needs to draw itself, and to redraw the thread when the visitor picks a score. */
export interface LinesContext {
  state: ChatState;
  config: ChatWidgetConfig;
  locale: ChatLocale;
  texts: ChatWidgetConfig['texts']['en'];
  strings: ChatStrings;
  /** Scores the visitor picked, by rating line, while the comment is still to send. */
  ratings: Map<string, number>;
  /** What they typed in a rating's comment box, kept across redraws. */
  comments: Map<string, string>;
  redraw: () => void;
}

export function drawMessages(log: HTMLDivElement, context: LinesContext): void {
  const { state, config, strings } = context;
  log.replaceChildren(welcomeOf(context));
  const now = Date.now();
  const last = lastShown(state);
  const seenId = seenLineId(state);
  let dotsShown = false;
  for (const message of state.messages) {
    if (message.revealAt && message.revealAt > now) {
      // The dots stand for every line still to come; the rest show one by one.
      log.append(typing(config.botName?.trim() || strings.bot, strings));
      dotsShown = true;
      break;
    }
    log.append(lineOf(message, message === last, context));
    if (message.id === seenId) log.append(seenMark(strings));
  }
  const agent = state.agentTyping;
  if (!dotsShown && agent && agent.until > now) {
    log.append(typing(agent.name ?? strings.team, strings));
  }
}

/** The last line the visitor can see: a bot line still "typing" is not there yet. */
export function lastShown(state: ChatState): ChatMessage | null {
  const now = Date.now();
  const shown = state.messages.filter((m) => !(m.revealAt && m.revealAt > now));
  return shown[shown.length - 1] ?? null;
}

function welcomeOf(context: LinesContext): HTMLDivElement {
  const { state, config, locale, texts, strings } = context;
  const welcome = bubble({ text: texts.welcome, side: 'team', who: strings.team });
  if (state.messages.length > 0) return welcome;
  const options = (config.welcomeOptions ?? []).filter((option) => option.label[locale]);
  if (options.length > 0) {
    welcome.append(
      chips(
        'welcome',
        options.map((option) => ({ key: option.key, label: option.label[locale] })),
        (option) => void chat.send(option.label, { option: option.key }),
      ),
    );
  }
  return welcome;
}

function lineOf(message: ChatMessage, isLast: boolean, context: LinesContext): HTMLElement {
  const { config, strings } = context;
  if (message.kind === 'notice') {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = message.text ?? '';
    return notice;
  }
  if (message.kind === 'rating') return ratingCard(message, context);
  const node = bubble({
    text: bodyOf(message),
    side: message.direction === 'in' ? 'you' : 'team',
    who: whoOf(message, config, strings),
  });
  if (message.sender.kind === 'bot') node.classList.add('bot');
  if (message.attachments?.length) node.append(filesOf(message.attachments, strings));
  const buttons = (message.payload?.buttons ?? []).filter((button) => isHttpUrl(button.url));
  if (buttons.length > 0) node.append(links(buttons));
  if (isLast && message.kind === 'choices' && message.payload?.options?.length) {
    node.append(
      chips(message.id, message.payload.options, (option) => {
        void chat.send(option.label, { option: option.key, replyTo: message.id });
      }),
    );
  }
  if (message.pending === 'sending') node.classList.add('pending');
  if (message.pending === 'failed') node.append(retryOf(message, strings, node));
  return node;
}

function retryOf(message: ChatMessage, strings: ChatStrings, node: HTMLDivElement): HTMLButtonElement {
  node.classList.add('failed');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry';
  retry.textContent = `${strings.failed} ${strings.retry}`;
  retry.addEventListener('click', () => {
    if (message.clientMessageId) void chat.retry(message.clientMessageId);
  });
  return retry;
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
  wrap.append(who);
  if (args.text) {
    const body = document.createElement('p');
    body.className = 'body';
    body.append(...linkified(args.text));
    wrap.append(body);
  }
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
  lineId: string,
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
    chip.dataset.focusKey = `chip:${lineId}:${option.key}`;
    chip.textContent = option.label;
    chip.addEventListener('click', () => onTap(option));
    row.append(chip);
  }
  return row;
}

/** A line's files: an image in place, a PDF as a link to save it; one still uploading by name. */
function filesOf(attachments: ChatAttachment[], strings: ChatStrings): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'files';
  for (const file of attachments) {
    if (!file.url || !isHttpUrl(file.url)) {
      const pending = document.createElement('span');
      pending.className = 'file pending';
      pending.textContent = `${file.name} · ${strings.uploading}`;
      wrap.append(pending);
      continue;
    }
    if (file.contentType.startsWith('image/')) {
      const link = anchor(file.url, '');
      link.className = 'image';
      const image = document.createElement('img');
      image.src = file.url;
      image.alt = file.name;
      image.loading = 'lazy';
      // Links last an hour: an image that no longer loads asks for a fresh one.
      image.addEventListener('error', () => void chat.refreshAttachment(file.id), { once: true });
      image.addEventListener('load', () => followEnd(image), { once: true });
      link.append(image);
      wrap.append(link);
      continue;
    }
    const link = anchor(file.url, `${file.name} · ${sizeOf(file.size)}`);
    link.className = 'file';
    wrap.append(link);
  }
  return wrap;
}

/**
 * An image grows the log once it loads, after the log was scrolled to its
 * end: a visitor who was reading the newest line keeps it in view.
 */
function followEnd(image: HTMLImageElement): void {
  const log = image.closest('.log');
  if (!(log instanceof HTMLElement)) return;
  const fromEnd = log.scrollHeight - log.scrollTop - log.clientHeight;
  if (fromEnd <= image.offsetHeight + NEAR_END_PX) log.scrollTop = log.scrollHeight;
}

function sizeOf(bytes: number): string {
  if (bytes >= MEGABYTE) return `${(bytes / MEGABYTE).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / KILOBYTE))} KB`;
}

/**
 * The rating a resolve asked for: five faces, then a comment box for the
 * score picked, then the visitor's answer and the thanks once sent.
 */
function ratingCard(message: ChatMessage, context: LinesContext): HTMLDivElement {
  const { strings, texts } = context;
  const node = bubble({
    text: message.text ?? texts.ratingPrompt,
    side: 'team',
    who: strings.team,
  });
  node.classList.add('rating');
  const answer = message.payload?.rating;
  if (answer?.score) {
    const done = document.createElement('p');
    done.className = 'rating-done';
    // A config cached before ratings came has no thanks to add.
    const thanks = texts.ratingThanks ? ` ${texts.ratingThanks}` : '';
    done.textContent = `${strings.ratingYours.replace('{score}', String(answer.score))}.${thanks}`;
    node.append(done);
    return node;
  }
  const chosen = context.ratings.get(message.id);
  const scores = document.createElement('div');
  scores.className = 'scores';
  scores.setAttribute('role', 'group');
  scores.setAttribute('aria-label', message.text ?? texts.ratingPrompt);
  RATING_FACES.forEach((face, index) => {
    const score = index + 1;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'score';
    button.textContent = face;
    button.dataset.focusKey = `score:${message.id}:${score}`;
    button.setAttribute('aria-label', strings.rateScores[index] ?? String(score));
    button.setAttribute('aria-pressed', String(chosen === score));
    button.addEventListener('click', () => {
      context.ratings.set(message.id, score);
      context.redraw();
    });
    scores.append(button);
  });
  node.append(scores);
  if (chosen) node.append(...ratingComment(message.id, chosen, context));
  return node;
}

function ratingComment(
  messageId: string,
  score: number,
  context: LinesContext,
): [HTMLTextAreaElement, HTMLButtonElement] {
  const comment = document.createElement('textarea');
  comment.className = 'rating-comment';
  comment.rows = 2;
  comment.maxLength = RATING_COMMENT_MAX_LENGTH;
  comment.placeholder = context.strings.ratingComment;
  comment.setAttribute('aria-label', context.strings.ratingComment);
  comment.dataset.focusKey = `rating-comment:${messageId}`;
  comment.value = context.comments.get(messageId) ?? '';
  comment.addEventListener('input', () => context.comments.set(messageId, comment.value));
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'rating-send';
  send.textContent = context.strings.send;
  send.addEventListener('click', () => {
    void chat.rate(messageId, score, comment.value).then((done) => {
      if (done) context.comments.delete(messageId);
    });
  });
  return [comment, send];
}

/** The visitor's newest line a teammate has read: where "Seen" goes. */
function seenLineId(state: ChatState): string | null {
  const readAt = state.conversation?.agentReadAt;
  if (!readAt) return null;
  const seen = state.messages.filter(
    (m) => m.direction === 'in' && !m.pending && m.at <= readAt,
  );
  return seen[seen.length - 1]?.id ?? null;
}

function seenMark(strings: ChatStrings): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = 'seen';
  mark.textContent = strings.seen;
  return mark;
}

/** The dots shown while a bot's line is on its way, or while a teammate is writing. */
function typing(who: string, strings: ChatStrings): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bubble team typing';
  wrap.setAttribute('aria-label', strings.typing);
  const label = document.createElement('span');
  label.className = 'who';
  label.textContent = who;
  const body = document.createElement('p');
  body.className = 'body dots';
  for (let i = 0; i < 3; i += 1) body.append(document.createElement('span'));
  wrap.append(label, body);
  return wrap;
}
