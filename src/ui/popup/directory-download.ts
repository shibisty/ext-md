// "A folder I choose" downloads, done in the popup/side panel because the
// File System Access API needs a window. Files are streamed to disk — never
// held in memory whole.

import { base64ToBytes } from '../../shared/base64';
import { baseNameFor, safeName } from '../../shared/filenames';
import { sendToTab } from '../../shared/messages';
import { STREAM_UNAVAILABLE } from '../../shared/types';
import { createUniqueWritable, ensurePermission, loadDirHandle, pickDirectory } from '../fs-handle';
import type { PopupItem } from './state';

export interface Outcome {
  done: number;
  failed: number;
  streamFailed: number;
}

export class DirectoryUnavailableError extends Error {}

async function writeHttp(root: FileSystemDirectoryHandle, path: string, url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`http-${res.status}`);
  const { writable, discard } = await createUniqueWritable(root, path);
  try {
    if (res.body) {
      await res.body.pipeTo(writable); // closes the writable on success, aborts it on error
      return;
    }
    await writable.write(new Uint8Array(await res.arrayBuffer()));
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    await discard();
    throw e;
  }
}

async function writeBlob(root: FileSystemDirectoryHandle, path: string, url: string, tabId: number): Promise<void> {
  const open = await sendToTab(tabId, { type: 'MG_STREAM_OPEN', url });
  if (!open || !open.ok) throw new Error(open && !open.ok ? open.error : STREAM_UNAVAILABLE);
  const { writable, discard } = await createUniqueWritable(root, path);
  let written = 0;
  try {
    for (;;) {
      const next = await sendToTab(tabId, { type: 'MG_STREAM_NEXT', id: open.id });
      if (!next || !next.ok) throw new Error(next && !next.ok ? next.error : STREAM_UNAVAILABLE);
      if (next.done) break;
      const bytes = base64ToBytes(next.base64);
      written += bytes.length;
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
    }
    if (written === 0) throw new Error(STREAM_UNAVAILABLE);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    await discard(); // don't leave an empty/partial video_1.mp4 behind
    throw e;
  }
}

/** Gets the saved folder (asking for one the first time) with write permission. */
export async function resolveDirectory(): Promise<FileSystemDirectoryHandle> {
  let handle = await loadDirHandle();
  if (!handle) {
    try {
      handle = await pickDirectory();
    } catch {
      throw new DirectoryUnavailableError('picker-cancelled');
    }
  }
  if (!(await ensurePermission(handle))) throw new DirectoryUnavailableError('permission-denied');
  return handle;
}

export async function downloadToDirectory(
  root: FileSystemDirectoryHandle,
  items: PopupItem[],
  pageHost: string,
  tabId: number,
  onProgress: (remaining: number) => void,
): Promise<Outcome> {
  const outcome: Outcome = { done: 0, failed: 0, streamFailed: 0 };
  const folder = safeName(pageHost, 'page');
  for (const [i, item] of items.entries()) {
    const path = `${folder}/${baseNameFor(item, i)}`;
    try {
      if (item.url.startsWith('blob:')) await writeBlob(root, path, item.url, tabId);
      else await writeHttp(root, path, item.url);
      outcome.done++;
    } catch (e) {
      outcome.failed++;
      if (e instanceof Error && e.message === STREAM_UNAVAILABLE) outcome.streamFailed++;
    }
    onProgress(items.length - i - 1);
  }
  return outcome;
}
