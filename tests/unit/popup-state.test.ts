import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_STATE, type ViewState } from '../../src/shared/settings';
import type { ScanData } from '../../src/shared/types';
import {
  buildItems,
  computeVisibleItems,
  counts,
  formatDuration,
  outcomeStatus,
  selectionMap,
  sizeLabel,
  tabIdFromSearch,
} from '../../src/ui/popup/state';
import { clampMenuPosition } from '../../src/ui/popup/context-menu';
import { rangeBetween } from '../../src/ui/popup/table';
import { clampScale } from '../../src/ui/popup/lightbox';
import { resolveTheme } from '../../src/ui/theme';

const scan: ScanData = {
  pageUrl: 'https://a.com/',
  pageTitle: 'A',
  externalSheets: [],
  images: [
    { url: 'https://a.com/big.jpg', source: 'img', width: 2000, height: 1000, alt: '' },
    { url: 'https://a.com/small.png', source: 'img', width: 32, height: 32, alt: '' },
    { url: 'https://a.com/unknown.webp', source: 'network', width: null, height: null, alt: '' },
  ],
  videos: [
    { url: 'https://a.com/clip.mp4', source: 'video', width: 640, height: 360, poster: null, duration: 125, isBlob: false },
  ],
};

const view = (patch: Partial<ViewState> = {}): ViewState => ({ ...DEFAULT_VIEW_STATE, ...patch });

describe('buildItems', () => {
  it('selects everything by default and restores the cache', () => {
    const items = buildItems(scan, { 'https://a.com/small.png': false });
    expect(items.map((i) => [i.id, i.format, i.selected])).toEqual([
      ['image-0', 'JPG', true],
      ['image-1', 'PNG', false],
      ['image-2', 'WEBP', true],
      ['video-0', 'MP4', true],
    ]);
    expect(selectionMap(items)['https://a.com/small.png']).toBe(false);
  });
});

describe('computeVisibleItems', () => {
  const items = buildItems(scan, null);

  it('filters by type', () => {
    expect(computeVisibleItems(items, view({ filter: 'video' })).map((i) => i.id)).toEqual(['video-0']);
  });

  it('filters by longest side, keeping unknown sizes', () => {
    const ids = computeVisibleItems(items, view({ sizeMin: '100', sizeMax: '1000' })).map((i) => i.id);
    expect(ids).toEqual(['image-2', 'video-0']);
  });

  it('ignores garbage bounds', () => {
    expect(computeVisibleItems(items, view({ sizeMin: 'abc' }))).toHaveLength(4);
  });

  it('sorts by size both ways, unknown first when ascending', () => {
    expect(computeVisibleItems(items, view({ sortKey: 'size', sortDir: 1 })).map((i) => i.id)).toEqual([
      'image-2',
      'image-1',
      'video-0',
      'image-0',
    ]);
    expect(computeVisibleItems(items, view({ sortKey: 'size', sortDir: -1 }))[0]!.id).toBe('image-0');
  });

  it('sorts by format and by type', () => {
    expect(computeVisibleItems(items, view({ sortKey: 'format' })).map((i) => i.format)).toEqual(['JPG', 'MP4', 'PNG', 'WEBP']);
    expect(computeVisibleItems(items, view({ sortKey: 'type', sortDir: -1 }))[0]!.type).toBe('video');
  });

  it('does not mutate the input', () => {
    const before = items.map((i) => i.id);
    computeVisibleItems(items, view({ sortKey: 'size', sortDir: -1 }));
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('labels and counters', () => {
  it('sizeLabel', () => {
    expect(sizeLabel({ type: 'image', width: 10, height: 20 })).toBe('10×20');
    expect(sizeLabel({ type: 'video', width: 10, height: 20, approxSize: true, duration: 125 })).toBe('≈10×20 · 2:05');
    expect(sizeLabel({ type: 'image', width: null, height: null })).toBe('—');
  });
  it('formatDuration', () => {
    expect(formatDuration(9.6)).toBe('10s');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
  it('counts', () => {
    expect(counts(buildItems(scan, { 'https://a.com/clip.mp4': false }))).toEqual({ total: 4, selected: 3, images: 3, videos: 1 });
  });
  it('outcomeStatus', () => {
    expect(outcomeStatus(3, 0, 0)).toEqual({ key: 'statusSuccess', subs: ['3'], kind: 'success' });
    expect(outcomeStatus(1, 2, 1).key).toBe('statusStreamWarning');
    expect(outcomeStatus(1, 2, 0)).toEqual({ key: 'statusPartial', subs: ['1', '2'], kind: 'error' });
  });
  it('tabIdFromSearch', () => {
    expect(tabIdFromSearch('?tabId=42')).toBe(42);
    expect(tabIdFromSearch('?tabId=x')).toBeNull();
    expect(tabIdFromSearch('')).toBeNull();
  });
});

describe('shift+click range', () => {
  const items = buildItems(scan, null);
  it('covers anchor..clicked in either direction', () => {
    expect(rangeBetween(items, 'image-0', 'image-2').map((i) => i.id)).toEqual(['image-0', 'image-1', 'image-2']);
    expect(rangeBetween(items, 'video-0', 'image-1').map((i) => i.id)).toEqual(['image-1', 'image-2', 'video-0']);
  });
  it('falls back to the clicked row without a visible anchor', () => {
    expect(rangeBetween(items, null, 'image-1').map((i) => i.id)).toEqual(['image-1']);
    expect(rangeBetween(items, 'gone', 'image-1').map((i) => i.id)).toEqual(['image-1']);
  });
});

describe('small UI helpers', () => {
  it('clampMenuPosition keeps the menu on screen', () => {
    expect(clampMenuPosition(10, 10, 100, 50, 400, 300)).toEqual({ x: 10, y: 10 });
    expect(clampMenuPosition(390, 290, 100, 50, 400, 300)).toEqual({ x: 296, y: 246 });
  });
  it('clampScale', () => {
    expect(clampScale(0.5)).toBe(1);
    expect(clampScale(10)).toBe(6);
  });
  it('resolveTheme', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });
});
