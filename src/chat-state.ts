import type { ChatMessage, ChatState } from './chat-types';

/**
 * The chat engine's one state and who hears of it: the view, through its
 * renderer and its subscription. Every module of the engine reads and
 * publishes here, so none of them needs another's internals.
 */

type Listener = (state: ChatState) => void;

let state: ChatState = emptyState();
let renderer: ((state: ChatState) => void) | null = null;
const listeners = new Set<Listener>();
let debug = false;
let running = false;

export function emptyState(): ChatState {
  return {
    config: null,
    conversation: null,
    messages: [],
    online: false,
    unread: 0,
    isOpen: false,
    identified: false,
    overQuota: false,
    agentTyping: null,
    proactive: null,
  };
}

export function current(): ChatState {
  return state;
}

export function publish(change: Partial<ChatState>): void {
  state = { ...state, ...change };
  renderer?.(state);
  for (const listener of listeners) listener(state);
}

/** Logout: the next person on this browser starts from nothing but the widget. */
export function resetState(): void {
  state = emptyState();
}

/** The DOM layer registers itself here; `index.ts` wires it at init. */
export function setRenderer(fn: (state: ChatState) => void): void {
  renderer = fn;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDebug(enabled: boolean): void {
  debug = enabled;
}

export function log(message: string): void {
  if (debug) console.info(`[arsel] chat: ${message}`);
}

/** Between `start()` and `stop()`: timers and the stream only run meanwhile. */
export function isRunning(): boolean {
  return running;
}

export function setRunning(value: boolean): void {
  running = value;
}

/** The visitor's own lines still in flight, kept across a session refresh. */
export function pendingLines(): ChatMessage[] {
  return state.messages.filter((m) => m.pending);
}

/** A line the widget wrote itself, which the server never had. */
export function isLocal(message: ChatMessage): boolean {
  return message.id.startsWith('local:');
}

export function withoutClientId(lines: ChatMessage[], clientMessageId: string): ChatMessage[] {
  return lines.filter((m) => m.clientMessageId !== clientMessageId);
}

/** Lines in order, each once: a pending line gives way to its stored self, a line to its newer self. */
export function mergeLines(base: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const line of incoming) byId.set(line.id, line);
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
