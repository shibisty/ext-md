import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadItems, downloadPlain, downloadZip, zipEntryName } from '../../src/background/download';
import { itemsForHotkey } from '../../src/background/hotkey';
import { ensureContentScript, fetchExternalSheetMedia, mergeScan } from '../../src/background/scan';
import { bytesToBase64 } from '../../src/shared/base64';
import { createRouter, type BackgroundRequests } from '../../src/shared/messages';
import type { ScanData } from '../../src/shared/types';

afterEach(() => vi.unstubAllGlobals());

// The fake service worker has no URL.createObjectURL by default in these tests,
// mirroring Chrome. Firefox's path is tested by stubbing it in.
function withoutObjectUrls() {
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: undefined, revokeObjectURL: undefined }));
}

describe('ensureContentScript', () => {
  it('does nothing when the content script answers the ping', async () => {
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    await ensureContentScript(5);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('resets the guard and injects when there is no live receiver', async () => {
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Could not establish connection'));
    await ensureContentScript(5);
    const calls = chromeMock.scripting.executeScript.mock.calls as unknown as [chrome.scripting.ScriptInjection<unknown[], unknown>][];
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toHaveProperty('func');
    expect(calls[1]![0]).toEqual({ target: { tabId: 5 }, files: ['content.js'] });
  });
});

describe('external stylesheets', () => {
  it('fetches sheets, classifies URLs and ignores failures', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('broken')) return new Response('nope', { status: 404 });
      return new Response('.a{background:url(img/a.png)} .b{background:url(/v/b.mp4)} .c{background:url(font.woff2)}');
    }) as unknown as typeof fetch;
    const res = await fetchExternalSheetMedia(['https://cdn.x.com/css/s.css', 'https://cdn.x.com/broken.css'], fetchImpl);
    expect(res.images.map((i) => i.url)).toEqual(['https://cdn.x.com/css/img/a.png']);
    expect(res.videos.map((v) => v.url)).toEqual(['https://cdn.x.com/v/b.mp4']);
  });

  it('mergeScan skips duplicates', () => {
    const data: ScanData = {
      pageUrl: '',
      pageTitle: '',
      externalSheets: [],
      images: [{ url: 'a', source: 'img', width: 1, height: 1, alt: '' }],
      videos: [],
    };
    mergeScan(data, {
      images: [
        { url: 'a', source: 'css-file', width: null, height: null, alt: '' },
        { url: 'b', source: 'css-file', width: null, height: null, alt: '' },
      ],
      videos: [],
    });
    expect(data.images.map((i) => [i.url, i.source])).toEqual([
      ['a', 'img'],
      ['b', 'css-file'],
    ]);
  });
});

describe('downloadPlain', () => {
  it('puts http files under <subfolder>/<host>/ and hands blob: videos to the page', async () => {
    withoutObjectUrls();
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: true });
    const results = await downloadPlain(
      7,
      [
        { url: 'https://a.com/p/cat.jpg', type: 'image' },
        { url: 'blob:https://a.com/123', type: 'video', mime: 'video/webm' },
      ],
      'a.com',
      { mg_subfolder: 'My:Pics' },
    );
    expect(chromeMock.downloads.download).toHaveBeenCalledWith({
      url: 'https://a.com/p/cat.jpg',
      filename: 'My_Pics/a.com/cat.jpg',
      saveAs: false,
      conflictAction: 'uniquify',
    });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'MG_NATIVE_DOWNLOAD', url: 'blob:https://a.com/123', filename: 'video_2.webm' });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it('reports per-item failures without stopping', async () => {
    withoutObjectUrls();
    chromeMock.downloads.download.mockRejectedValueOnce(new Error('Invalid URL')).mockResolvedValueOnce(2);
    chromeMock.tabs.sendMessage.mockResolvedValue({ ok: false, error: 'stream-unavailable' });
    const results = await downloadPlain(
      1,
      [
        { url: 'https://a.com/1.jpg', type: 'image' },
        { url: 'https://a.com/2.jpg', type: 'image' },
        { url: 'blob:https://a.com/x', type: 'video' },
      ],
      'a.com',
      { mg_subfolder: 'MG' },
    );
    expect(results.map((r) => [r.ok, r.error])).toEqual([
      [false, 'Invalid URL'],
      [true, undefined],
      [false, 'stream-unavailable'],
    ]);
  });

  it('turns data: URLs into blob: URLs where object URLs exist (Firefox)', async () => {
    const createObjectURL = vi.fn(() => 'blob:moz-extension://x/1');
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL: vi.fn() }));
    await downloadPlain(1, [{ url: 'data:image/png;base64,iVBORw0KGgo=', type: 'image' }], 'a.com', { mg_subfolder: 'MG' });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(chromeMock.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:moz-extension://x/1', filename: 'MG/a.com/image_1.png' }));
    expect(chromeMock.downloads.onChanged.addListener).toHaveBeenCalled();
  });
});

describe('downloadZip', () => {
  it('fetches http + streamed blob bytes and downloads one archive', async () => {
    withoutObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })));
    const chunks = [{ ok: true, id: 's1', mime: 'video/mp4' }, { ok: true, done: false, base64: bytesToBase64(new Uint8Array([9, 9])) }, { ok: true, done: true }];
    chromeMock.tabs.sendMessage.mockImplementation(async () => chunks.shift());

    const results = await downloadZip(3, [
      { url: 'https://a.com/x.png', type: 'image' },
      { url: 'blob:https://a.com/v', type: 'video' },
    ], 'a.com');

    expect(results.every((r) => r.ok)).toBe(true);
    const call = (chromeMock.downloads.download.mock.calls as unknown as [chrome.downloads.DownloadOptions][])[0]![0];
    expect(call.filename).toBe('a.com-media-grabber.zip');
    expect(call.url.startsWith('data:application/zip;base64,')).toBe(true);
    const zip = atob(call.url.split(',')[1]!);
    expect(zip).toContain('01_x.png');
    expect(zip).toContain('02_video_2.mp4');
  });

  it('does not put HTTP error pages into the archive', async () => {
    withoutObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>404</html>', { status: 404 })));
    const results = await downloadZip(3, [{ url: 'https://a.com/gone.jpg', type: 'image' }], 'a.com');
    expect(results).toEqual([{ url: 'https://a.com/gone.jpg', ok: false, error: 'http-404' }]);
    expect(chromeMock.downloads.download).not.toHaveBeenCalled();
  });

  it('zipEntryName pads to the item count', () => {
    expect(zipEntryName({ url: 'https://a.com/a.jpg', type: 'image' }, 4, 120)).toBe('005_a.jpg');
  });

  it('downloadItems picks the mode from settings', async () => {
    withoutObjectUrls();
    await chrome.storage.local.set({ mg_download_mode: 'zip' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    await downloadItems(1, [{ url: 'https://a.com/a.jpg', type: 'image' }], 'a.com');
    expect((chromeMock.downloads.download.mock.calls as unknown as [{ filename: string }][])[0]![0].filename).toMatch(/\.zip$/);
  });
});

describe('hotkey selection', () => {
  it('downloads all found items except ones unticked on this page before', () => {
    const data: ScanData = {
      pageUrl: '',
      pageTitle: '',
      externalSheets: [],
      images: [
        { url: 'a', source: 'img', width: 1, height: 1, alt: '' },
        { url: 'b', source: 'img', width: 1, height: 1, alt: '' },
      ],
      videos: [{ url: 'v', source: 'video', width: 1, height: 1, poster: null, duration: null, isBlob: false }],
    };
    expect(itemsForHotkey(data, null).map((i) => i.url)).toEqual(['a', 'b', 'v']);
    expect(itemsForHotkey(data, { b: false, v: true }).map((i) => i.url)).toEqual(['a', 'v']);
  });
});

describe('createRouter', () => {
  const sender = {} as chrome.runtime.MessageSender;

  it('ignores unknown messages so other listeners can answer', () => {
    const route = createRouter<BackgroundRequests>({});
    expect(route({ type: 'NOPE' }, sender, vi.fn())).toBeUndefined();
    expect(route(null, sender, vi.fn())).toBeUndefined();
  });

  it('answers async handlers and converts throws into { ok: false }', async () => {
    const route = createRouter<BackgroundRequests>({
      MG_SCAN_TAB: async ({ tabId }) => {
        if (tabId === 0) throw new Error('boom');
        return { ok: false, error: `tab ${tabId}` };
      },
    });
    const ok = vi.fn();
    expect(route({ type: 'MG_SCAN_TAB', tabId: 3 }, sender, ok)).toBe(true);
    const bad = vi.fn();
    route({ type: 'MG_SCAN_TAB', tabId: 0 }, sender, bad);
    await vi.waitFor(() => expect(bad).toHaveBeenCalled());
    expect(ok).toHaveBeenCalledWith({ ok: false, error: 'tab 3' });
    expect(bad).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });
});
