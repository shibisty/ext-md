// URL classification and CSS url(...) extraction — shared by the content
// script (same-origin sheets) and the background (cross-origin sheets).

import type { MediaType } from './types';

export const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)(\?|#|$)/i;
export const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv)(\?|#|$)/i;

export function classify(url: string): MediaType | null {
  if (IMAGE_EXT.test(url)) return 'image';
  if (VIDEO_EXT.test(url)) return 'video';
  return null;
}

export function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Removes /* comments *\/ so url(...) inside them is not picked up. */
export function stripCssComments(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extracts absolute url(...) references from raw CSS text, skipping data: URIs. */
export function extractCssUrls(cssText: string, baseHref: string): string[] {
  const found: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const text = stripCssComments(cssText);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = (m[2] ?? '').trim();
    if (!raw || raw.startsWith('data:')) continue;
    try {
      found.push(new URL(raw, baseHref).href);
    } catch {
      /* malformed — skip */
    }
  }
  return found;
}

/** First url(...) of a computed background-image value, or null. */
export function firstCssUrl(value: string | null | undefined): string | null {
  if (!value || value === 'none') return null;
  const match = value.match(/url\((['"]?)(.*?)\1\)/);
  return match && match[2] ? match[2] : null;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
};

export function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const clean = mime.split(';')[0]!.trim().toLowerCase();
  return MIME_EXT[clean] ?? null;
}

/** Short label for the "Format" column: JPG, PNG, MP4, STREAM… */
export function guessFormat(url: string, type: MediaType, mime?: string | null): string {
  const fromMime = extFromMime(mime);
  if (fromMime) return fromMime.toUpperCase();
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([a-z0-9.+-]+)\/([a-z0-9.+-]+)/i);
    if (match) {
      const ext = extFromMime(`${match[1]}/${match[2]}`);
      return (ext ?? match[2]!).toUpperCase();
    }
    return type === 'video' ? 'VIDEO' : 'IMAGE';
  }
  if (url.startsWith('blob:')) return type === 'video' ? 'STREAM' : 'BLOB';
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot > -1) {
      const ext = last.slice(dot + 1);
      if (ext && ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)) return ext.toUpperCase();
    }
  } catch {
    /* ignore */
  }
  return type === 'video' ? 'VIDEO' : 'IMAGE';
}

export function hostOf(url: string | undefined | null, fallback = 'page'): string {
  try {
    return new URL(url ?? '').hostname || fallback;
  } catch {
    return fallback;
  }
}

export function isHttpUrl(url: string | undefined | null): boolean {
  return /^https?:/i.test(url ?? '');
}
