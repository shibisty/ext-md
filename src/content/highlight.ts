// Red inner outline on the page element that matches the hovered table row.

import { absolute } from '../shared/media';
import { bgImageUrl } from './collect';

const FALLBACK_CLASS = '__mg_highlight_fallback__';
const OUTLINE = '3px solid #e02424';

let highlighted: HTMLElement | null = null;

function mark(el: HTMLElement): void {
  el.style.outline = OUTLINE;
  el.style.outlineOffset = '-3px';
}

function unmark(el: HTMLElement): void {
  el.style.outline = '';
  el.style.outlineOffset = '';
}

export function clearHighlight(doc: Document = document): void {
  if (highlighted) {
    unmark(highlighted);
    highlighted = null;
  }
  doc.querySelectorAll<HTMLElement>(`.${FALLBACK_CLASS}`).forEach((el) => {
    unmark(el);
    el.classList.remove(FALLBACK_CLASS);
  });
}

export function highlightByMgId(mgId: string, doc: Document = document): boolean {
  clearHighlight(doc);
  // Our own ids are always "mg-<n>"; anything else is rejected rather than escaped.
  if (!/^mg-\d+$/.test(mgId)) return false;
  const el = doc.querySelector<HTMLElement>(`[data-mg-id="${mgId}"]`);
  if (!el) return false;
  highlighted = el;
  mark(el);
  el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  return true;
}

/** For css-file / network items: every element whose computed background is this URL. */
export function highlightByUrl(url: string, doc: Document = document): number {
  clearHighlight(doc);
  let count = 0;
  doc.querySelectorAll<HTMLElement>('body *').forEach((el) => {
    const raw = bgImageUrl(el, doc.defaultView ?? window);
    if (raw && absolute(raw, doc.baseURI) === url) {
      mark(el);
      el.classList.add(FALLBACK_CLASS);
      count++;
    }
  });
  return count;
}
