// Media table rendering and mouse selection:
// click a row → toggle it; drag across rows → set them all to the state the
// first row is switching to; checkbox → toggle; double click → lightbox.

import { t } from '../../shared/i18n';
import { sizeLabel, type PopupItem } from './state';

const VIDEO_PLACEHOLDER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><polygon points="10 9 16 12 10 15" fill="currentColor" stroke="none"></polygon></svg>';
const IMAGE_PLACEHOLDER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><circle cx="8" cy="10" r="1.6" fill="currentColor" stroke="none"></circle><polyline points="3 17 9 12 13 15 21 8"></polyline></svg>';
const EXPAND_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 3 3 3 3 9"></polyline><polyline points="15 3 21 3 21 9"></polyline><polyline points="3 15 3 21 9 21"></polyline><polyline points="21 15 21 21 15 21"></polyline></svg>';

export interface TableCallbacks {
  /** Selection of one or more items changed; rows are already updated in place (refresh counters + persist). */
  onSelectionChange(): void;
  onOpen(item: PopupItem): void;
  onContextMenu(item: PopupItem, x: number, y: number): void;
  onHover(item: PopupItem | null): void;
}

// Static SVG constants, parsed once and cloned (AMO's linter flags HTML-string assignment).
const svgCache = new Map<string, Element>();
function svg(markup: string): Node {
  let el = svgCache.get(markup);
  if (!el) {
    el = new DOMParser().parseFromString(markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'image/svg+xml').documentElement;
    svgCache.set(markup, el);
  }
  return document.importNode(el, true);
}

function placeholder(type: PopupItem['type']): HTMLElement {
  const ph = document.createElement('span');
  ph.className = 'placeholder';
  ph.appendChild(svg(type === 'video' ? VIDEO_PLACEHOLDER_SVG : IMAGE_PLACEHOLDER_SVG));
  return ph;
}

function renderThumb(item: PopupItem): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'thumb';
  const src = item.type === 'image' ? item.url : item.poster;
  if (src && !src.startsWith('blob:')) {
    const img = document.createElement('img');
    img.src = src;
    img.loading = 'lazy';
    img.alt = item.alt ?? '';
    img.onerror = () => {
      img.remove();
      wrap.appendChild(placeholder(item.type));
    };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(placeholder(item.type));
  }
  return wrap;
}

/**
 * Shift+click: ids from the anchor row to the clicked row (inclusive) in the
 * current visible order, or just the clicked row if the anchor is not visible.
 */
export function rangeBetween(visible: PopupItem[], anchorId: string | null, clickedId: string): PopupItem[] {
  const to = visible.findIndex((it) => it.id === clickedId);
  const from = anchorId === null ? -1 : visible.findIndex((it) => it.id === anchorId);
  if (to < 0) return [];
  if (from < 0) return [visible[to]!];
  return visible.slice(Math.min(from, to), Math.max(from, to) + 1);
}

export class MediaTable {
  private mouseDownItem: PopupItem | null = null;
  private mouseDownShift = false;
  private dragStarted = false;
  private dragTargetState = true;
  private anchorId: string | null = null;
  private visible: PopupItem[] = [];
  private rows = new Map<string, { tr: HTMLTableRowElement; check: HTMLInputElement }>();

  constructor(
    private readonly body: HTMLElement,
    private readonly cb: TableCallbacks,
  ) {
    // window + capture: the release must end the gesture even if it happens
    // outside the table or the popup.
    window.addEventListener('mouseup', () => this.endGesture(), true);
    window.addEventListener('blur', () => this.cancelGesture());
  }

  private endGesture(): void {
    const item = this.mouseDownItem;
    if (item && !this.dragStarted) {
      const target = !item.selected;
      const affected = this.mouseDownShift ? rangeBetween(this.visible, this.anchorId, item.id) : [item];
      this.setSelected(affected, target);
      this.anchorId = item.id;
    }
    this.cancelGesture();
  }

  private cancelGesture(): void {
    this.mouseDownItem = null;
    this.dragStarted = false;
  }

  /**
   * Updates rows in place. The old code re-rendered the whole table on every
   * row the drag passed over, which detached the row under the cursor;
   * Chrome then could lose the mouseup and the drag "stuck" — later hovers
   * kept changing the selection.
   */
  private setSelected(items: PopupItem[], selected: boolean): void {
    for (const it of items) {
      it.selected = selected;
      this.syncRow(it);
    }
    this.cb.onSelectionChange();
  }

  private syncRow(item: PopupItem): void {
    const row = this.rows.get(item.id);
    if (!row) return;
    row.tr.classList.toggle('selected', item.selected);
    row.check.checked = item.selected;
  }

  render(visible: PopupItem[]): void {
    this.visible = visible;
    this.rows.clear();
    const fragment = document.createDocumentFragment();
    for (const item of visible) fragment.appendChild(this.renderRow(item));
    this.body.replaceChildren(fragment);
  }

  private renderRow(item: PopupItem): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    tr.className = `${item.selected ? 'selected ' : ''}${item.type === 'video' ? 'row-video' : 'row-image'}`;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = item.selected;
    check.addEventListener('mousedown', (e) => e.stopPropagation());
    check.addEventListener('change', () => this.setSelected([item], check.checked));
    this.rows.set(item.id, { tr, check });
    tdCheck.appendChild(check);

    const tdThumb = document.createElement('td');
    tdThumb.className = 'col-thumb';
    tdThumb.appendChild(renderThumb(item));
    const expandBtn = document.createElement('button');
    expandBtn.className = 'expand-btn';
    expandBtn.appendChild(svg(EXPAND_SVG));
    expandBtn.title = t('expandTitle');
    expandBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onOpen(item);
    });
    tdThumb.appendChild(expandBtn);

    const tdSize = document.createElement('td');
    tdSize.className = 'col-size';
    tdSize.textContent = sizeLabel(item);

    const tdFormat = document.createElement('td');
    tdFormat.className = 'col-format';
    tdFormat.textContent = item.format;
    if (item.format === 'STREAM') tdFormat.title = t('streamFormatHint');

    tr.append(tdCheck, tdThumb, tdSize, tdFormat);

    tr.addEventListener('dblclick', () => this.cb.onOpen(item));
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cb.onContextMenu(item, e.clientX, e.clientY);
    });
    tr.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as Element).closest('button, input')) return;
      this.mouseDownItem = item;
      this.mouseDownShift = e.shiftKey;
      this.dragStarted = false;
      this.dragTargetState = !item.selected;
      e.preventDefault();
    });
    tr.addEventListener('mouseenter', (e) => {
      this.cb.onHover(item);
      if (!this.mouseDownItem) return;
      // Button already released (mouseup lost outside the window): end the drag.
      if ((e.buttons & 1) === 0) {
        this.cancelGesture();
        return;
      }
      if (this.mouseDownItem === item) return;
      if (!this.dragStarted) {
        this.dragStarted = true;
        this.setSelected([this.mouseDownItem], this.dragTargetState);
      }
      this.setSelected([item], this.dragTargetState);
    });
    tr.addEventListener('mouseleave', () => this.cb.onHover(null));
    return tr;
  }
}
