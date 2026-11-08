import { registerDevice } from './push';
import { KEYS, get } from './store';

/**
 * The visitor, as the chat API knows them: the browser's registered device,
 * and the proof of possession every call that touches the conversation
 * carries. Plus where the page is, which the server keeps for the inbox.
 */

export const DEVICE_AUTH_HEADER = 'X-Arsel-Device-Auth';

export interface Device {
  clientKey: string;
  baseUrl: string;
  installationId: string;
  deviceSecret: string;
}

export async function readDevice(): Promise<Device | null> {
  const [clientKey, baseUrl, installationId, deviceSecret] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
    get<string>(KEYS.installationId),
    get<string>(KEYS.deviceSecret),
  ]);
  if (!clientKey || !baseUrl || !installationId || !deviceSecret) return null;
  return { clientKey, baseUrl, installationId, deviceSecret };
}

/** Registers the browser on first use, when in-app has not done it: the moment the visitor writes. */
export async function ensureDevice(): Promise<Device | null> {
  const existing = await readDevice();
  if (existing) return existing;
  if (!(await registerDevice())) return null;
  return readDevice();
}

export function deviceHeaders(device: Device): Record<string, string> {
  return { [DEVICE_AUTH_HEADER]: device.deviceSecret };
}

export function chatPath(clientKey: string): string {
  return `/api/v1/orgs/${encodeURIComponent(clientKey)}/chat`;
}

export function readLocale(): string {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement?.lang;
    if (lang) return lang;
  }
  return typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en';
}

export function readPage(): { url?: string; title?: string } {
  if (typeof document === 'undefined') return {};
  const url = typeof location !== 'undefined' ? location.href : undefined;
  const title = document.title || undefined;
  return {
    ...(url && /^https?:/.test(url) ? { url: url.slice(0, 2048) } : {}),
    ...(title ? { title: title.slice(0, 200) } : {}),
  };
}
