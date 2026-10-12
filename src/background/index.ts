// Background entry: service worker in Chrome, event page in Firefox.
// All listeners are registered synchronously at top level so a restarted
// worker receives the event that woke it.

import { createRouter, type BackgroundRequests } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { downloadItems } from './download';
import { onHotkey } from './hotkey';
import { scanTab } from './scan';

chrome.runtime.onMessage.addListener(
  createRouter<BackgroundRequests>({
    MG_SCAN_TAB: ({ tabId }) => scanTab(tabId),
    MG_DOWNLOAD_ITEMS: async ({ tabId, items, pageHost, saveAs, forceMode }) => ({
      ok: true,
      results: await downloadItems(tabId, items, pageHost, { saveAs, forceMode }),
    }),
    MG_GET_SETTINGS: () => loadSettings(),
  }),
);

chrome.commands.onCommand.addListener((command) => {
  void onHotkey(command);
});
