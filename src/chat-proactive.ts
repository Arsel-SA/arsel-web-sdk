import { current } from './chat-state';
import type { ChatProactiveMessage, ChatWidgetConfig } from './chat-types';
import { KEYS, get, set } from './store';

/**
 * The organization's proactive messages, judged in the browser from the
 * config the widget already holds: no request per page view. One shows per
 * page view at most, never while the visitor is chatting, and each no more
 * often than its days allow on this browser.
 */

const MS_PER_SECOND = 1000;
const DAY_MS = 24 * 60 * 60 * MS_PER_SECOND;
/** Leaving within the first seconds is not leaving: the pointer is still finding the page. */
const EXIT_INTENT_ARMED_AFTER_MS = 5 * MS_PER_SECOND;
/** A single-page app changes the address without a load; this often the widget looks. */
const ADDRESS_CHECK_MS = MS_PER_SECOND;

type Show = (message: ChatProactiveMessage) => void;

let timers: ReturnType<typeof setTimeout>[] = [];
let addressTimer: ReturnType<typeof setInterval> | null = null;
let exitListener: ((event: MouseEvent) => void) | null = null;
let fired = false;

export function startProactive(config: ChatWidgetConfig, show: Show): void {
  stopProactive();
  const rules = config.proactive ?? [];
  if (rules.length === 0 || typeof window === 'undefined' || typeof location === 'undefined') {
    return;
  }
  fired = false;
  arm(rules, show);
  let address = location.href;
  addressTimer = setInterval(() => {
    if (location.href === address) return;
    address = location.href;
    disarm();
    if (!fired) arm(rules, show);
  }, ADDRESS_CHECK_MS);
}

export function stopProactive(): void {
  disarm();
  if (addressTimer) clearInterval(addressTimer);
  addressTimer = null;
}

/** The current page's watches: a timer per time-on-page message, and the pointer for exit intent. */
function arm(rules: readonly ChatProactiveMessage[], show: Show): void {
  const pageStartMs = Date.now();
  for (const rule of rules) {
    if (rule.trigger !== 'time_on_page') continue;
    timers.push(setTimeout(() => void attempt(rule, show), rule.seconds * MS_PER_SECOND));
  }
  const exits = rules.filter((rule) => rule.trigger === 'exit_intent');
  if (exits.length === 0 || !finePointer()) return;
  exitListener = (event: MouseEvent) => {
    // Out through the top edge, to the tabs or the address bar, not into the page.
    if (event.relatedTarget || event.clientY > 0) return;
    if (Date.now() - pageStartMs < EXIT_INTENT_ARMED_AFTER_MS) return;
    for (const rule of exits) void attempt(rule, show);
  };
  document.addEventListener('mouseout', exitListener);
}

function disarm(): void {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  if (exitListener) document.removeEventListener('mouseout', exitListener);
  exitListener = null;
}

async function attempt(rule: ChatProactiveMessage, show: Show): Promise<void> {
  if (fired || !applies(rule)) return;
  if (!(await dueAgain(rule)) || fired) return;
  fired = true;
  disarm();
  await remember(rule);
  show(rule);
}

/** Whether the message suits this page and this moment. */
function applies(rule: ChatProactiveMessage): boolean {
  const state = current();
  if (state.isOpen || state.proactive) return false;
  const chatting =
    state.conversation?.status === 'open' &&
    state.messages.some((message) => message.direction === 'in');
  if (chatting) return false;
  if (rule.urlContains && !location.href.includes(rule.urlContains)) return false;
  if (rule.when === 'online' && !state.online) return false;
  if (rule.when === 'offline' && state.online) return false;
  return true;
}

async function dueAgain(rule: ChatProactiveMessage): Promise<boolean> {
  const shown = (await get<Record<string, number>>(KEYS.chatProactive)) ?? {};
  const last = shown[rule.key];
  return !last || Date.now() - last >= rule.everyDays * DAY_MS;
}

async function remember(rule: ChatProactiveMessage): Promise<void> {
  const shown = (await get<Record<string, number>>(KEYS.chatProactive)) ?? {};
  await set(KEYS.chatProactive, { ...shown, [rule.key]: Date.now() });
}

/** A mouse or trackpad: exit intent means nothing on a touch screen. */
function finePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}
