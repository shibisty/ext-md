// Content script entry. Injected on demand by the background
// (scripting.executeScript) — never declared in the manifest, so pages the
// user never opens the extension on are untouched.

import { createRouter, type ContentRequests } from '../shared/messages';
import { blobUrlToDataUrl, nextBlobChunk, openBlobStream, triggerNativeDownload } from './blob-stream';
import { collectMedia } from './collect';
import { clearHighlight, highlightByMgId, highlightByUrl } from './highlight';
import { startNetworkTracking } from './network';

declare global {
  interface Window {
    __mediaGrabberInstalled?: boolean;
  }
}

function install(): void {
  // The background pings before injecting and resets this flag when the ping
  // fails (e.g. an orphaned script left over from an extension reload), so the
  // guard only protects against a double injection racing itself.
  if (window.__mediaGrabberInstalled) return;
  window.__mediaGrabberInstalled = true;

  const network = startNetworkTracking(window);

  chrome.runtime.onMessage.addListener(
    createRouter<ContentRequests>({
      MG_PING: () => ({ ok: true }),
      MG_SCAN: () => ({
        ok: true,
        data: collectMedia({ network: network.snapshot(location.href, performance.now()) }),
      }),
      MG_RESOLVE_BLOB: async ({ url }) => ({ ok: true, ...(await blobUrlToDataUrl(url)) }),
      MG_NATIVE_DOWNLOAD: ({ url, filename }) => triggerNativeDownload(url, filename),
      MG_STREAM_OPEN: async ({ url }) => ({ ok: true, ...(await openBlobStream(url)) }),
      MG_STREAM_NEXT: async ({ id }) => ({ ok: true, ...(await nextBlobChunk(id)) }),
      MG_HIGHLIGHT: ({ mgId, url }) => {
        // mgId can be stale if the page re-rendered since the scan — fall back to URL matching.
        if (mgId && highlightByMgId(mgId)) return { ok: true };
        if (url) highlightByUrl(url);
        else clearHighlight();
        return { ok: true };
      },
      MG_CLEAR_HIGHLIGHT: () => {
        clearHighlight();
        return { ok: true };
      },
    }),
  );
}

install();
