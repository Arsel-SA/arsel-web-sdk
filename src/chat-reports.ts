import { chatPath } from './chat-device';
import { KEYS, get } from './store';
import { post } from './transport';

/**
 * What the widget tells the organization about its proactive messages, for
 * their figures on the Widget page: that one showed, or that the visitor
 * opened its teaser. Fire and forget, and most often before the visitor ever
 * wrote, so without a device to prove: the server checks the origin, as it
 * does for the config. A reply is counted by the server itself.
 */

export type ProactiveReport = 'shown' | 'opened';

export function reportProactive(key: string, event: ProactiveReport): void {
  void (async () => {
    const [clientKey, baseUrl, installationId] = await Promise.all([
      get<string>(KEYS.clientKey),
      get<string>(KEYS.baseUrl),
      get<string>(KEYS.installationId),
    ]);
    if (!clientKey || !baseUrl) return;
    await post(baseUrl, `${chatPath(clientKey)}/proactive`, {
      key,
      event,
      // Only so this browser's reports share its own throttle bucket.
      ...(installationId ? { installationId } : {}),
    });
  })().catch(() => undefined);
}
