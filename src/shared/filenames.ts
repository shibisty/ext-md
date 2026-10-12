// One file-naming implementation for every download mode. Previously the
// popup and the background each had their own copy, and the popup one named
// blob videos "video_1.stream" (it used the "STREAM" format label as the
// extension).

import { extFromMime } from './media';
import type { MediaType } from './types';

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
// Names Windows refuses regardless of extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME = 150;

export function safeName(str: string | null | undefined, fallback: string): string {
  let cleaned = (str ?? '').replace(FORBIDDEN, '_').trim();
  // Trailing dots/spaces are silently stripped by Windows and break paths.
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (!cleaned) return fallback;
  if (RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > MAX_NAME) {
    const dot = cleaned.lastIndexOf('.');
    const ext = dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : '';
    cleaned = cleaned.slice(0, MAX_NAME - ext.length) + ext;
  }
  return cleaned;
}

export interface NameableItem {
  url: string;
  type: MediaType;
  mime?: string | null;
}

/** File name for the index-th item: last path segment if it has an extension, else `<type>_<n>.<ext>`. */
export function baseNameFor(item: NameableItem, index: number): string {
  let base: string | null = null;
  if (!item.url.startsWith('data:') && !item.url.startsWith('blob:')) {
    try {
      const last = new URL(item.url).pathname.split('/').filter(Boolean).pop() ?? '';
      try {
        base = decodeURIComponent(last);
      } catch {
        base = last;
      }
    } catch {
      base = null;
    }
  }
  const fallbackStem = `${item.type}_${index + 1}`;
  const mimeExt = extFromMime(item.mime) ?? (item.url.startsWith('data:') ? extFromMime(item.url.slice(5).split(/[;,]/)[0]) : null);
  if (!base || !/\.[a-z0-9]{2,5}$/i.test(base)) {
    const ext = mimeExt ?? (item.type === 'video' ? 'mp4' : 'jpg');
    base = base ? `${base}.${ext}` : `${fallbackStem}.${ext}`;
  }
  return safeName(base, fallbackStem);
}
