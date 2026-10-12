// Pure, DOM-free logic of the media table: building rows from a scan,
// filtering, sorting and labels. Everything here is unit-tested.

import { guessFormat } from '../../shared/media';
import type { SelectionMap } from '../../shared/selection-cache';
import type { ViewState } from '../../shared/settings';
import type { MediaType, MediaSource, ScanData } from '../../shared/types';

export interface PopupItem {
  id: string;
  type: MediaType;
  url: string;
  source: MediaSource;
  width: number | null;
  height: number | null;
  approxSize?: boolean;
  poster?: string | null;
  duration?: number | null;
  alt?: string;
  mgId?: string;
  mime?: string | null;
  format: string;
  selected: boolean;
}

export function buildItems(data: ScanData, cache: SelectionMap | null): PopupItem[] {
  const restore = (url: string) => (cache && Object.prototype.hasOwnProperty.call(cache, url) ? cache[url] !== false : true);
  return [
    ...data.images.map((img, i): PopupItem => ({
      ...img,
      id: `image-${i}`,
      type: 'image',
      format: guessFormat(img.url, 'image'),
      selected: restore(img.url),
    })),
    ...data.videos.map((vid, i): PopupItem => ({
      ...vid,
      id: `video-${i}`,
      type: 'video',
      format: guessFormat(vid.url, 'video'),
      selected: restore(vid.url),
    })),
  ];
}

export function sizeLabel(item: Pick<PopupItem, 'width' | 'height' | 'approxSize' | 'type' | 'duration'>): string {
  const parts: string[] = [];
  if (item.width && item.height) parts.push(`${item.approxSize ? '≈' : ''}${item.width}×${item.height}`);
  if (item.type === 'video' && item.duration) parts.push(formatDuration(item.duration));
  return parts.length ? parts.join(' · ') : '—';
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function longestSide(item: Pick<PopupItem, 'width' | 'height'>): number | null {
  if (!item.width || !item.height) return null;
  return Math.max(item.width, item.height);
}

function sizeSortValue(item: PopupItem): number {
  return item.width && item.height ? item.width * item.height : -1;
}

function parseBound(value: string): number | null {
  if (!value.trim()) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Rows to show: sorted (stable), then filtered by type and longest-side range. Unknown sizes always pass. */
export function computeVisibleItems(items: PopupItem[], view: ViewState): PopupItem[] {
  let list = items.slice();
  const { sortKey, sortDir } = view;
  if (sortKey) {
    const value = (it: PopupItem): string | number =>
      sortKey === 'size' ? sizeSortValue(it) : sortKey === 'type' ? it.type : it.format;
    list.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
  }
  if (view.filter !== 'all') list = list.filter((it) => it.type === view.filter);
  const min = parseBound(view.sizeMin);
  const max = parseBound(view.sizeMax);
  if (min !== null || max !== null) {
    list = list.filter((it) => {
      const side = longestSide(it);
      if (side === null) return true;
      if (min !== null && side < min) return false;
      if (max !== null && side > max) return false;
      return true;
    });
  }
  return list;
}

export function counts(items: PopupItem[]): { total: number; selected: number; images: number; videos: number } {
  let selected = 0;
  let images = 0;
  for (const it of items) {
    if (it.selected) selected++;
    if (it.type === 'image') images++;
  }
  return { total: items.length, selected, images, videos: items.length - images };
}

export function selectionMap(items: PopupItem[]): SelectionMap {
  const map: SelectionMap = {};
  for (const it of items) map[it.url] = it.selected;
  return map;
}

export interface StatusMessage {
  key: string;
  subs: string[];
  kind: 'success' | 'error';
}

/** Which status line to show after a download run. */
export function outcomeStatus(done: number, failed: number, streamFailed: number): StatusMessage {
  if (failed === 0) return { key: 'statusSuccess', subs: [String(done)], kind: 'success' };
  if (streamFailed > 0) return { key: 'statusStreamWarning', subs: [String(done), String(streamFailed)], kind: 'error' };
  return { key: 'statusPartial', subs: [String(done), String(failed)], kind: 'error' };
}

/** Tab ID passed explicitly (?tabId=123) — used by e2e tests and by "open in tab" flows. */
export function tabIdFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get('tabId');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
