import { base64ToBytes, bytesToBase64, concatBytes } from '../shared/base64';
import { baseNameFor, safeName } from '../shared/filenames';
import { sendToTab } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { STREAM_UNAVAILABLE, errorMessage, type DownloadItem, type DownloadMode, type DownloadResult, type Settings } from '../shared/types';
import { createZip, type ZipEntry } from '../shared/zip';

/** Pulls a blob: URL's bytes from the page a few MB per message. */
export async function streamBlobToBytes(tabId: number, url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const open = await sendToTab(tabId, { type: 'MG_STREAM_OPEN', url });
  if (!open || !open.ok) throw new Error(open && !open.ok ? open.error : STREAM_UNAVAILABLE);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await sendToTab(tabId, { type: 'MG_STREAM_NEXT', id: open.id });
    if (!next || !next.ok) throw new Error(next && !next.ok ? next.error : STREAM_UNAVAILABLE);
    if (next.done) break;
    chunks.push(base64ToBytes(next.base64));
  }
  const bytes = concatBytes(chunks);
  if (bytes.length === 0) throw new Error(STREAM_UNAVAILABLE);
  return { bytes, mime: open.mime };
}

export async function fetchBytes(tabId: number, item: DownloadItem): Promise<Uint8Array> {
  if (item.url.startsWith('blob:')) {
    const { bytes, mime } = await streamBlobToBytes(tabId, item.url);
    if (!item.mime) item.mime = mime || null;
    return bytes;
  }
  const res = await fetch(item.url);
  // Without this check a 404/403 page used to end up in the zip as "photo.jpg".
  if (!res.ok) throw new Error(`http-${res.status}`);
  const buf = await res.arrayBuffer();
  if (!item.mime) item.mime = res.headers.get('content-type');
  return new Uint8Array(buf);
}

/**
 * A URL chrome.downloads can take. In Chrome's service worker there is no
 * URL.createObjectURL, so data: URLs are used as-is. Firefox's event page has
 * it, and Firefox's downloads API is more reliable with blob: than with
 * data: URLs, so bytes/data: URLs become blob: URLs there.
 */
export function canUseObjectUrls(): boolean {
  return typeof URL.createObjectURL === 'function';
}

async function startDownload(options: chrome.downloads.DownloadOptions, blob?: Blob): Promise<number> {
  if (!blob || !canUseObjectUrls()) return chrome.downloads.download(options);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ ...options, url: objectUrl });
    revokeWhenDone(id, objectUrl);
    return id;
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    throw e;
  }
}

function revokeWhenDone(downloadId: number, objectUrl: string): void {
  const listener = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      chrome.downloads.onChanged.removeListener(listener);
      URL.revokeObjectURL(objectUrl);
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

/**
 * "Downloads folder" mode. http(s) files go straight to the browser's download
 * manager (no size limit, survives the popup closing). blob: videos are
 * clicked as <a download> inside the page for the same reason — they can't
 * get a sub-folder, that's a limitation of <a download>.
 */
export async function downloadPlain(
  tabId: number,
  items: DownloadItem[],
  pageHost: string,
  settings: Pick<Settings, 'mg_subfolder'>,
  saveAs = false,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  const folder = `${safeName(settings.mg_subfolder, 'MediaGrabber')}/${safeName(pageHost || 'page', 'page')}`;
  for (const [i, item] of items.entries()) {
    try {
      const base = baseNameFor(item, i);
      if (item.url.startsWith('blob:')) {
        const res = await sendToTab(tabId, { type: 'MG_NATIVE_DOWNLOAD', url: item.url, filename: base });
        if (!res || !res.ok) throw new Error(res && !res.ok ? res.error : STREAM_UNAVAILABLE);
        results.push({ url: item.url, ok: true, native: true });
        continue;
      }
      const filename = `${folder}/${base}`;
      const blob = item.url.startsWith('data:') && canUseObjectUrls() ? await dataUrlToBlob(item.url) : undefined;
      const downloadId = await startDownload({ url: item.url, filename, saveAs, conflictAction: 'uniquify' }, blob);
      results.push({ url: item.url, ok: true, downloadId });
    } catch (e) {
      results.push({ url: item.url, ok: false, error: errorMessage(e) });
    }
  }
  return results;
}

/** Name inside the archive: "01_photo.jpg" keeps the table order and avoids collisions. */
export function zipEntryName(item: DownloadItem, index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, '0')}_${baseNameFor(item, index)}`;
}

/** ".zip" mode: everything bundled into one archive, downloaded once (works headless). */
export async function downloadZip(tabId: number, items: DownloadItem[], pageHost: string, saveAs = false): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  const files: ZipEntry[] = [];
  for (const [i, item] of items.entries()) {
    try {
      const data = await fetchBytes(tabId, item);
      files.push({ name: zipEntryName(item, i, items.length), data });
      results.push({ url: item.url, ok: true });
    } catch (e) {
      results.push({ url: item.url, ok: false, error: errorMessage(e) });
    }
  }
  if (files.length === 0) return results;

  const zipBytes = createZip(files);
  const filename = `${safeName(pageHost || 'media', 'media')}-media-grabber.zip`;
  if (canUseObjectUrls()) {
    await startDownload({ url: 'about:blank', filename, saveAs }, new Blob([zipBytes as BlobPart], { type: 'application/zip' }));
  } else {
    await chrome.downloads.download({ url: `data:application/zip;base64,${bytesToBase64(zipBytes)}`, filename, saveAs });
  }
  return results;
}

export async function downloadItems(
  tabId: number,
  items: DownloadItem[],
  pageHost: string,
  opts: { saveAs?: boolean; forceMode?: DownloadMode } = {},
): Promise<DownloadResult[]> {
  const settings = await loadSettings();
  const mode = opts.forceMode ?? settings.mg_download_mode;
  if (mode === 'zip') return downloadZip(tabId, items, pageHost, opts.saveAs);
  // 'directory' is handled by the popup/side panel (File System Access API
  // needs a window); if it ever reaches here, fall back to plain downloads.
  return downloadPlain(tabId, items, pageHost, settings, opts.saveAs);
}
