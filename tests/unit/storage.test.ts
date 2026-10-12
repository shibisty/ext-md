import { describe, expect, it } from 'vitest';
import {
  SELECTION_INDEX,
  clearAllSelections,
  loadSelection,
  saveSelection,
  selectionKey,
  touchIndex,
} from '../../src/shared/selection-cache';
import { DEFAULT_SETTINGS, loadSettings, loadViewState, normalizeSettings, saveViewState } from '../../src/shared/settings';

describe('normalizeSettings', () => {
  it('falls back to defaults for missing/invalid values', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ mg_download_mode: 'ftp', mg_lang: 'de', mg_theme: 'pink', mg_subfolder: '  ' })).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps valid values and trims the subfolder', () => {
    expect(normalizeSettings({ mg_download_mode: 'zip', mg_lang: 'uk', mg_theme: 'light', mg_subfolder: ' Pics ' })).toEqual({
      mg_download_mode: 'zip',
      mg_lang: 'uk',
      mg_theme: 'light',
      mg_subfolder: 'Pics',
    });
  });
  it('loadSettings reads chrome.storage.local', async () => {
    await chrome.storage.local.set({ mg_download_mode: 'directory' });
    expect((await loadSettings()).mg_download_mode).toBe('directory');
  });
});

describe('view state', () => {
  it('round-trips and sanitizes', async () => {
    await saveViewState({ sortKey: 'size', sortDir: -1, filter: 'video', sizeMin: '100', sizeMax: '' });
    expect(await loadViewState()).toEqual({ sortKey: 'size', sortDir: -1, filter: 'video', sizeMin: '100', sizeMax: '' });
    await chrome.storage.local.set({ mg_sort_key: 'evil', mg_filter: 'x' });
    const v = await loadViewState();
    expect(v.sortKey).toBeNull();
    expect(v.filter).toBe('all');
  });
});

describe('selection cache', () => {
  it('touchIndex moves to front and evicts the oldest', () => {
    expect(touchIndex(['b', 'a'], 'a', 3)).toEqual({ index: ['a', 'b'], evicted: [] });
    expect(touchIndex(['c', 'b', 'a'], 'd', 3)).toEqual({ index: ['d', 'c', 'b'], evicted: ['a'] });
  });

  it('saves, loads and evicts beyond the limit', async () => {
    await saveSelection('https://a.com/1', { x: true }, 2);
    await saveSelection('https://a.com/2', { y: false }, 2);
    await saveSelection('https://a.com/3', { z: true }, 2);
    expect(await loadSelection('https://a.com/3')).toEqual({ z: true });
    expect(await loadSelection('https://a.com/2')).toEqual({ y: false });
    expect(await loadSelection('https://a.com/1')).toBeNull();
    const data = chromeMock.storage.local._data();
    expect(data[SELECTION_INDEX]).toEqual(['https://a.com/3', 'https://a.com/2']);
    expect(selectionKey('https://a.com/1') in data).toBe(false);
  });

  it('clearAllSelections removes only selection keys', async () => {
    await chrome.storage.local.set({ mg_theme: 'dark' });
    await saveSelection('https://a.com/1', { x: true });
    await clearAllSelections();
    expect(chromeMock.storage.local._data()).toEqual({ mg_theme: 'dark' });
  });
});
