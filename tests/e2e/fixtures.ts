import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = process.env.MG_EXT_DIR || resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist/chrome');

// 1×1 PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/**
 * Two origins: `page` serves the test page, `cdn` serves a cross-origin
 * stylesheet (which the content script can't read → background fetches it).
 */
export interface Servers {
  page: string;
  cdn: string;
  close(): Promise<void>;
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  return new Promise((ok) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

export async function startServers(): Promise<Servers> {
  const cdn = await listen((req, res) => {
    if (req.url === '/cdn.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('.from-cdn { background-image: url(/img/cdn-bg.png); } /* .old { background: url(/img/commented.png) } */');
    } else if (req.url?.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else {
      res.writeHead(404).end();
    }
  });
  const cdnOrigin = cdn.origin.replace('127.0.0.1', 'localhost');

  const page = await listen((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Fixture</title>
<link rel="stylesheet" href="${cdnOrigin}/cdn.css">
<style>.local-bg { background-image: url(/img/local-bg.png); }</style>
</head><body>
<img id="photo" src="/img/photo.png" alt="photo" width="200" height="100">
<img src="/img/photo.png">
<div class="local-bg" style="width:100px;height:100px"></div>
<div id="inline-bg" style="width:120px;height:80px;background-image:url(/img/inline-bg.png)"></div>
<video id="clip" src="/media/clip.mp4" width="320" height="180"></video>
<video id="blobvid" width="160" height="90"></video>
<script>
  // A lazily loaded image that is removed from the DOM again — only the network log knows it.
  const lazy = new Image(); lazy.src = '/img/lazy.png'; lazy.onload = () => { window.lazyDone = true; };
  // A regular (non-MSE) blob: video.
  const bytes = new Uint8Array(300000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  document.getElementById('blobvid').src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
</script>
</body></html>`);
    } else if (url.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else if (url === '/media/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.alloc(5000, 7));
    } else {
      res.writeHead(404).end();
    }
  });

  return {
    page: page.origin,
    cdn: cdnOrigin,
    close: async () => {
      for (const { server } of [page, cdn]) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  };
}

interface Fixtures {
  servers: Servers;
  context: BrowserContext;
  extensionId: string;
  worker: () => Promise<Worker>;
  openPopup: (page: Page, file?: string) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  servers: async ({}, use) => {
    const s = await startServers();
    await use(s);
    await s.close();
  },
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'mg-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
  worker: async ({ context }, use) => {
    await use(async () => {
      const live = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
      const w = live ?? (await context.waitForEvent('serviceworker'));
      // A just-registered worker can be evaluated before extension APIs are bound.
      for (let i = 0; i < 50; i++) {
        if (await w.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local).catch(() => false)) return w;
        await new Promise((r) => setTimeout(r, 100));
      }
      return w;
    });
  },
  extensionId: async ({ worker }, use) => {
    const w = await worker();
    await use(new URL(w.url()).host);
  },
  openPopup: async ({ context, extensionId, worker }, use) => {
    await use(async (page, file = 'popup.html') => {
      const sw = await worker();
      const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
      if (tabId === undefined) throw new Error(`tab not found for ${page.url()}`);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/${file}?tabId=${tabId}`);
      return popup;
    });
  },
});

export { expect } from '@playwright/test';
