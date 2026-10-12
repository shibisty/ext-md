// Media seen in network traffic (Resource Timing), kept by the content script
// itself instead of read-and-cleared from the page's buffer.
//
// The old code called performance.clearResourceTimings() after every scan.
// That (a) wiped the page's own Resource Timing data, which analytics/RUM
// scripts on the page rely on, and (b) made "Rescan" lose every network-only
// item found by the previous scan. A PerformanceObserver gets every entry
// even after the page's 250-entry buffer is full, and SPA route changes are
// handled by a time cutoff instead of clearing.

import { classify } from '../shared/media';
import type { MediaType } from '../shared/types';

export interface NetworkEntry {
  url: string;
  type: MediaType;
  startTime: number;
}

const MAX_ENTRIES = 5000;

export class NetworkTracker {
  private entries = new Map<string, NetworkEntry>();
  private cutoff = 0;
  private lastScanHref: string;
  private lastScanTime = 0;
  private navigatedSinceScan = false;

  constructor(href: string) {
    this.lastScanHref = href;
  }

  /**
   * Records a resource entry if it looks like an image/video URL. Entries
   * that failed with an HTTP error (e.g. a 404 favicon.ico) are skipped;
   * responseStatus is 0 when the browser doesn't expose it — kept then.
   */
  add(url: string, startTime: number, responseStatus = 0): void {
    if (responseStatus >= 400) return;
    const type = classify(url);
    if (!type) return;
    const existing = this.entries.get(url);
    if (existing) {
      existing.startTime = Math.max(existing.startTime, startTime);
      return;
    }
    if (this.entries.size >= MAX_ENTRIES) this.prune(true);
    this.entries.set(url, { url, type, startTime });
  }

  /** Same-document navigation (SPA route change) happened at `time`. */
  markNavigation(time: number): void {
    this.cutoff = Math.max(this.cutoff, time);
    this.navigatedSinceScan = true;
    this.prune(false);
  }

  /**
   * Entries that belong to the current page. If the URL changed since the
   * previous scan but no navigation event was seen (browsers without the
   * Navigation API), everything loaded before that previous scan is treated
   * as belonging to the old route.
   */
  snapshot(href: string, now: number): NetworkEntry[] {
    if (href !== this.lastScanHref && !this.navigatedSinceScan) {
      this.cutoff = Math.max(this.cutoff, this.lastScanTime);
      this.prune(false);
    }
    this.lastScanHref = href;
    this.lastScanTime = now;
    this.navigatedSinceScan = false;
    return [...this.entries.values()].filter((e) => e.startTime >= this.cutoff);
  }

  private prune(dropOldestHalf: boolean): void {
    for (const [url, e] of this.entries) if (e.startTime < this.cutoff) this.entries.delete(url);
    if (dropOldestHalf && this.entries.size >= MAX_ENTRIES) {
      const sorted = [...this.entries.values()].sort((a, b) => a.startTime - b.startTime);
      for (const e of sorted.slice(0, sorted.length / 2)) this.entries.delete(e.url);
    }
  }
}

/** URL without the fragment — what identifies an SPA "page". */
export function routeOf(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

function addEntry(tracker: NetworkTracker, e: PerformanceEntry): void {
  const status = (e as PerformanceEntry & { responseStatus?: number }).responseStatus ?? 0;
  tracker.add(e.name, e.startTime, status);
}

/** Wires a tracker to the real window: existing buffer, observer, Navigation API. */
export function startNetworkTracking(win: Window & typeof globalThis): NetworkTracker {
  const tracker = new NetworkTracker(win.location.href);
  try {
    for (const e of win.performance.getEntriesByType('resource')) addEntry(tracker, e);
  } catch {
    /* Performance API unavailable */
  }
  try {
    if (typeof win.PerformanceObserver === 'function') {
      const observer = new win.PerformanceObserver((list) => {
        for (const e of list.getEntries()) addEntry(tracker, e);
      });
      observer.observe({ type: 'resource' });
    }
  } catch {
    /* observer unsupported */
  }
  // Route changes: the cutoff is taken when the navigation *starts* (resources
  // the new route requests during the transition must survive), and
  // fragment-only changes (#section) are not route changes at all.
  const nav = (win as unknown as { navigation?: EventTarget }).navigation;
  let lastRoute = routeOf(win.location.href);
  const onRouteMaybeChanged = (nextUrl: string) => {
    const next = routeOf(nextUrl);
    if (next !== lastRoute) {
      lastRoute = next;
      tracker.markNavigation(win.performance.now());
    }
  };
  if (nav?.addEventListener) {
    nav.addEventListener('navigate', (e) => {
      const ev = e as Event & { hashChange?: boolean; destination?: { url?: string } };
      if (!ev.hashChange && ev.destination?.url) onRouteMaybeChanged(ev.destination.url);
    });
  }
  win.addEventListener('popstate', () => onRouteMaybeChanged(win.location.href));
  return tracker;
}
