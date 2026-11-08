// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatProactiveMessage } from '../src/chat-types';
import { CONFIG, drained } from './chat-fixtures';

/**
 * Exit intent: the pointer leaving through the top of the page, on a device
 * with a mouse, once the visitor had a few seconds to find the page.
 */

type ProactiveModule = typeof import('../src/chat-proactive');
type StateModule = typeof import('../src/chat-state');
type StoreModule = typeof import('../src/store');

let proactive: ProactiveModule;
let chatState: StateModule;
let store: StoreModule;

const LEAVING: ChatProactiveMessage = {
  key: 'leaving',
  trigger: 'exit_intent',
  seconds: 0,
  urlContains: null,
  when: 'always',
  display: 'teaser',
  everyDays: 7,
  text: { en: 'Before you go: 10% off today', ar: 'قبل أن تغادر: خصم 10٪ اليوم' },
};

const leaveThroughTheTop = () =>
  document.dispatchEvent(new MouseEvent('mouseout', { clientY: -2, relatedTarget: null }));

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: fine)' }));
  store = await import('../src/store');
  chatState = await import('../src/chat-state');
  proactive = await import('../src/chat-proactive');
  await store.remove(store.KEYS.chatProactive);
  chatState.publish({ config: CONFIG, online: true });
});

afterEach(() => {
  proactive.stopProactive();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('exit intent', () => {
  it('shows the message when the pointer leaves through the top, not in the first seconds', async () => {
    const show = vi.fn();
    proactive.startProactive({ ...CONFIG, proactive: [LEAVING] }, show);

    leaveThroughTheTop();
    await drained();
    expect(show).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 6_000);
    leaveThroughTheTop();
    await drained();
    expect(show).toHaveBeenCalledWith(LEAVING);

    leaveThroughTheTop();
    await drained();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('ignores the pointer moving into the page, and a touch screen altogether', async () => {
    const show = vi.fn();
    proactive.startProactive({ ...CONFIG, proactive: [LEAVING] }, show);
    vi.setSystemTime(Date.now() + 6_000);

    document.dispatchEvent(new MouseEvent('mouseout', { clientY: 300, relatedTarget: document.body }));
    await drained();
    expect(show).not.toHaveBeenCalled();

    proactive.stopProactive();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    proactive.startProactive({ ...CONFIG, proactive: [LEAVING] }, show);
    vi.setSystemTime(Date.now() + 6_000);
    leaveThroughTheTop();
    await drained();
    expect(show).not.toHaveBeenCalled();
  });

  it('stays quiet while the visitor is chatting, and when the team is away for a message meant for when it is in', async () => {
    const show = vi.fn();
    chatState.publish({
      conversation: { id: 'c1', status: 'open', agent: null },
      messages: [
        { id: 'm1', direction: 'in', at: '2026-11-08T09:00:00.000Z', kind: 'text', text: 'Hi', sender: { kind: 'visitor', name: null } },
      ],
    });
    proactive.startProactive({ ...CONFIG, proactive: [LEAVING] }, show);
    vi.setSystemTime(Date.now() + 6_000);
    leaveThroughTheTop();
    await drained();
    expect(show).not.toHaveBeenCalled();

    proactive.stopProactive();
    chatState.publish({ conversation: null, messages: [], online: false });
    proactive.startProactive({ ...CONFIG, proactive: [{ ...LEAVING, when: 'online' }] }, show);
    vi.setSystemTime(Date.now() + 6_000);
    leaveThroughTheTop();
    await drained();
    expect(show).not.toHaveBeenCalled();
  });
});
