import { hostOf, isHttpUrl } from '../shared/media';
import { loadSelection, type SelectionMap } from '../shared/selection-cache';
import { loadSettings } from '../shared/settings';
import type { DownloadItem, ScanData } from '../shared/types';
import { downloadItems } from './download';
import { scanTab } from './scan';

export const HOTKEY_COMMAND = 'download-all';
export const TRIGGER_FLAG = 'mg_trigger_download_all';

/** Everything found on the page minus what the user explicitly unticked there before. */
export function itemsForHotkey(data: ScanData, selection: SelectionMap | null): DownloadItem[] {
  const all: DownloadItem[] = [
    ...data.images.map((i) => ({ url: i.url, type: 'image' as const })),
    ...data.videos.map((v) => ({ url: v.url, type: 'video' as const })),
  ];
  return all.filter((it) => !selection || selection[it.url] !== false);
}

export async function onHotkey(command: string): Promise<void> {
  if (command !== HOTKEY_COMMAND) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isHttpUrl(tab.url)) return;

  const settings = await loadSettings();
  if (settings.mg_download_mode === 'directory') {
    // The folder mode needs a window (File System Access API): open the popup
    // and let it pick up the "download everything now" flag.
    try {
      await chrome.storage.session.set({ [TRIGGER_FLAG]: true });
      await chrome.action.openPopup();
    } catch {
      /* openPopup may be refused outside a user gesture on some platforms */
    }
    return;
  }

  try {
    const scan = await scanTab(tab.id);
    if (!scan.ok) return;
    const items = itemsForHotkey(scan.data, await loadSelection(tab.url!));
    if (items.length === 0) return;
    await downloadItems(tab.id, items, hostOf(tab.url), { saveAs: false });
  } catch {
    /* no UI to report to */
  }
}
