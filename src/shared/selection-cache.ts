// Per-page selection memory: which checkboxes the user left on/off for an
// exact page URL. Previously every visited page added a storage key forever;
// now an index keeps the most recent MAX_PAGES and evicts the rest, so
// storage.local (10 MB quota) can't fill up over months of browsing.

export const SELECTION_PREFIX = 'mg_sel::';
export const SELECTION_INDEX = 'mg_sel_index';
export const MAX_PAGES = 300;

export type SelectionMap = Record<string, boolean>;

export function selectionKey(pageUrl: string): string {
  return SELECTION_PREFIX + pageUrl;
}

export async function loadSelection(pageUrl: string): Promise<SelectionMap | null> {
  if (!pageUrl) return null;
  const key = selectionKey(pageUrl);
  const stored = await chrome.storage.local.get(key);
  const map = stored[key];
  return map && typeof map === 'object' ? (map as SelectionMap) : null;
}

/** Most-recent-first list of page URLs after touching `pageUrl`, plus the URLs that fell off the end. */
export function touchIndex(index: string[], pageUrl: string, max = MAX_PAGES): { index: string[]; evicted: string[] } {
  const next = [pageUrl, ...index.filter((u) => u !== pageUrl)];
  return { index: next.slice(0, max), evicted: next.slice(max) };
}

export async function saveSelection(pageUrl: string, map: SelectionMap, max = MAX_PAGES): Promise<void> {
  if (!pageUrl) return;
  const stored = await chrome.storage.local.get(SELECTION_INDEX);
  const current = Array.isArray(stored[SELECTION_INDEX]) ? (stored[SELECTION_INDEX] as string[]) : [];
  const { index, evicted } = touchIndex(current, pageUrl, max);
  await chrome.storage.local.set({ [selectionKey(pageUrl)]: map, [SELECTION_INDEX]: index });
  if (evicted.length) await chrome.storage.local.remove(evicted.map(selectionKey));
}

export async function clearAllSelections(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(SELECTION_PREFIX) || k === SELECTION_INDEX);
  if (keys.length) await chrome.storage.local.remove(keys);
}
