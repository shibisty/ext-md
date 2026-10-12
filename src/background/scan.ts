import { classify, extractCssUrls } from '../shared/media';
import { sendToTab } from '../shared/messages';
import type { FoundImage, FoundVideo, ScanData } from '../shared/types';

export const CONTENT_SCRIPT_FILE = 'content.js';

/**
 * Makes sure a live content script answers in the tab. No in-memory "already
 * injected" set (the old INJECTED_TABS): a service worker is restarted every
 * few minutes and loses it, and it couldn't tell a live script from an
 * orphaned one left over from an extension reload. A ping can.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const pong = await sendToTab(tabId, { type: 'MG_PING' });
    if (pong?.ok) return;
  } catch {
    /* no receiver — inject below */
  }
  // An orphaned script may have left the install flag in the isolated world.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      delete (window as Window & { __mediaGrabberInstalled?: boolean }).__mediaGrabberInstalled;
    },
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
}

export async function fetchExternalSheetMedia(
  sheetUrls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ images: FoundImage[]; videos: FoundVideo[] }> {
  const images: FoundImage[] = [];
  const videos: FoundVideo[] = [];
  await Promise.all(
    sheetUrls.map(async (href) => {
      try {
        const res = await fetchImpl(href, { credentials: 'omit' });
        if (!res.ok) return;
        const text = await res.text();
        for (const url of extractCssUrls(text, href)) {
          const type = classify(url);
          if (type === 'image') images.push({ url, source: 'css-file', width: null, height: null, alt: '' });
          else if (type === 'video') videos.push({ url, source: 'css-file', width: null, height: null, poster: null, duration: null, isBlob: false });
        }
      } catch {
        /* unreachable stylesheet — ignore */
      }
    }),
  );
  return { images, videos };
}

/** Appends extra items to the scan, skipping URLs it already has. Mutates and returns `data`. */
export function mergeScan(data: ScanData, extra: { images: FoundImage[]; videos: FoundVideo[] }): ScanData {
  const seenImg = new Set(data.images.map((i) => i.url));
  const seenVid = new Set(data.videos.map((v) => v.url));
  for (const i of extra.images) {
    if (!seenImg.has(i.url)) {
      seenImg.add(i.url);
      data.images.push(i);
    }
  }
  for (const v of extra.videos) {
    if (!seenVid.has(v.url)) {
      seenVid.add(v.url);
      data.videos.push(v);
    }
  }
  return data;
}

export async function scanTab(tabId: number): Promise<{ ok: true; data: ScanData } | { ok: false; error: string }> {
  await ensureContentScript(tabId);
  const res = await sendToTab(tabId, { type: 'MG_SCAN' });
  if (!res) return { ok: false, error: 'no-response' };
  if (!res.ok) return res;
  const { data } = res;
  if (data.externalSheets.length) mergeScan(data, await fetchExternalSheetMedia(data.externalSheets));
  return { ok: true, data };
}
