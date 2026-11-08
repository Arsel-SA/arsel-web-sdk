import { chatPath, deviceHeaders, type Device } from './chat-device';
import type { ChatAttachment } from './chat-types';
import { RESULT, getJson, postForm } from './transport';

/**
 * The visitor's files: an image or a PDF, uploaded on its own request and
 * then sent with a line by its id. The server reads the type from the file's
 * bytes; the checks here only spare the visitor an upload that would fail.
 */

export const ATTACHMENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
];
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Why a file did not go: too big, not an image or a PDF, too many this hour, or the upload failed. */
export type FileRefusal = 'too_large' | 'type' | 'limit' | 'failed';

/** What the browser can tell before uploading; an unknown type is left to the server. */
export function refusalOf(file: { size: number; type: string }): FileRefusal | null {
  if (file.size > ATTACHMENT_MAX_BYTES) return 'too_large';
  if (file.type && !ATTACHMENT_TYPES.includes(file.type)) return 'type';
  return null;
}

export async function upload(
  device: Device,
  file: Blob & { name?: string },
): Promise<{ attachment: ChatAttachment } | { refusal: FileRefusal }> {
  const form = new FormData();
  form.append('file', file, file.name ?? 'file');
  // The device id rides in the query: the throttle reads it before the body is parsed.
  const query = new URLSearchParams({ installationId: device.installationId });
  const response = await postForm<ChatAttachment>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/attachments?${query.toString()}`,
    form,
    deviceHeaders(device),
    true,
  );
  if (response.result === RESULT.success && response.body) {
    return { attachment: response.body };
  }
  if (response.code === HTTP_TOO_MANY_REQUESTS) return { refusal: 'limit' };
  if (response.code === HTTP_BAD_REQUEST) return { refusal: 'type' };
  return { refusal: 'failed' };
}

/** A fresh link to a file of the visitor's conversation, once the one they hold ran out. */
export async function freshLink(
  device: Device,
  attachmentId: string,
): Promise<ChatAttachment | null> {
  const query = new URLSearchParams({
    installationId: device.installationId,
    id: attachmentId,
  });
  const response = await getJson<ChatAttachment>(
    device.baseUrl,
    `${chatPath(device.clientKey)}/attachment?${query.toString()}`,
    deviceHeaders(device),
    true,
  );
  return response.result === RESULT.success ? response.body : null;
}
