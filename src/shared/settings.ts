import type { DownloadMode, LangSetting, Settings, ThemeSetting } from './types';

export const DEFAULT_SETTINGS: Settings = {
  mg_download_mode: 'downloads',
  mg_subfolder: 'MediaGrabber',
  mg_lang: 'auto',
  mg_theme: 'system',
};

const MODES: DownloadMode[] = ['downloads', 'zip', 'directory'];
const LANGS: LangSetting[] = ['auto', 'ru', 'en', 'uk'];
const THEMES: ThemeSetting[] = ['system', 'light', 'dark'];

/** Merges stored values over defaults, dropping anything invalid. */
export function normalizeSettings(stored: Record<string, unknown>): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (MODES.includes(stored.mg_download_mode as DownloadMode)) s.mg_download_mode = stored.mg_download_mode as DownloadMode;
  if (typeof stored.mg_subfolder === 'string' && stored.mg_subfolder.trim()) s.mg_subfolder = stored.mg_subfolder.trim();
  if (LANGS.includes(stored.mg_lang as LangSetting)) s.mg_lang = stored.mg_lang as LangSetting;
  if (THEMES.includes(stored.mg_theme as ThemeSetting)) s.mg_theme = stored.mg_theme as ThemeSetting;
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return normalizeSettings(stored);
}

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/** View state shared across pages: sort, type filter and size filter. */
export interface ViewState {
  sortKey: SortKey | null;
  sortDir: 1 | -1;
  filter: 'all' | 'image' | 'video';
  sizeMin: string;
  sizeMax: string;
}
export type SortKey = 'type' | 'size' | 'format';

export const DEFAULT_VIEW_STATE: ViewState = { sortKey: null, sortDir: 1, filter: 'all', sizeMin: '', sizeMax: '' };

export async function loadViewState(): Promise<ViewState> {
  const s = await chrome.storage.local.get(['mg_sort_key', 'mg_sort_dir', 'mg_filter', 'mg_size_min', 'mg_size_max']);
  const v = { ...DEFAULT_VIEW_STATE };
  if (s.mg_sort_key === 'type' || s.mg_sort_key === 'size' || s.mg_sort_key === 'format') v.sortKey = s.mg_sort_key;
  v.sortDir = s.mg_sort_dir === -1 ? -1 : 1;
  if (s.mg_filter === 'image' || s.mg_filter === 'video' || s.mg_filter === 'all') v.filter = s.mg_filter;
  if (typeof s.mg_size_min === 'string') v.sizeMin = s.mg_size_min;
  if (typeof s.mg_size_max === 'string') v.sizeMax = s.mg_size_max;
  return v;
}

export async function saveViewState(v: ViewState): Promise<void> {
  await chrome.storage.local.set({
    mg_sort_key: v.sortKey,
    mg_sort_dir: v.sortDir,
    mg_filter: v.filter,
    mg_size_min: v.sizeMin,
    mg_size_max: v.sizeMax,
  });
}
