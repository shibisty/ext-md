// Enlarged preview with wheel zoom, drag-to-pan and double-click zoom toggle.

import { t } from '../../shared/i18n';
import { sendToTab } from '../../shared/messages';
import type { PopupItem } from './state';

export interface Lightbox {
  open(item: PopupItem, tabId: number | null): Promise<void>;
  close(): void;
}

export function clampScale(scale: number): number {
  return Math.min(6, Math.max(1, scale));
}

export function createLightbox(root: HTMLElement, content: HTMLElement, closeBtn: HTMLElement): Lightbox {
  let zoom = { scale: 1, x: 0, y: 0 };
  let panning = false;
  let panStart = { x: 0, y: 0 };
  let panOrigin = { x: 0, y: 0 };
  let openToken = 0;

  const target = () => content.querySelector<HTMLElement>('img, video');
  const reset = () => {
    zoom = { scale: 1, x: 0, y: 0 };
    panning = false;
  };
  const apply = () => {
    const el = target();
    if (!el) return;
    el.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
    el.style.cursor = zoom.scale > 1 ? 'grab' : 'zoom-in';
  };

  function close(): void {
    openToken++;
    root.classList.add('hidden');
    content.replaceChildren();
    reset();
  }

  async function open(item: PopupItem, tabId: number | null): Promise<void> {
    const token = ++openToken;
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    content.replaceChildren(spinner);
    root.classList.remove('hidden');
    reset();

    let src = item.url;
    let streamFailed = false;
    if (item.url.startsWith('blob:')) {
      try {
        const res = tabId === null ? null : await sendToTab(tabId, { type: 'MG_RESOLVE_BLOB', url: item.url });
        if (res?.ok) src = res.dataUrl;
        else streamFailed = true;
      } catch {
        streamFailed = true;
      }
    }
    if (token !== openToken) return; // closed or reopened meanwhile

    content.replaceChildren();
    if (item.type === 'video' && streamFailed) {
      if (item.poster) {
        const img = document.createElement('img');
        img.src = item.poster;
        content.appendChild(img);
      }
      const note = document.createElement('p');
      note.className = 'lightbox-note';
      note.textContent = t('streamPreviewUnavailable');
      content.appendChild(note);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      content.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = src;
      content.appendChild(img);
    }
    apply();
  }

  closeBtn.addEventListener('click', close);
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.classList.contains('hidden')) close();
  });

  content.addEventListener(
    'wheel',
    (e) => {
      if (!target()) return;
      e.preventDefault();
      zoom.scale = clampScale(zoom.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (zoom.scale === 1) zoom = { scale: 1, x: 0, y: 0 };
      apply();
    },
    { passive: false },
  );

  content.addEventListener('mousedown', (e) => {
    const el = target();
    if (!el || zoom.scale <= 1) return;
    panning = true;
    panStart = { x: e.clientX, y: e.clientY };
    panOrigin = { x: zoom.x, y: zoom.y };
    el.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!panning) return;
    zoom.x = panOrigin.x + (e.clientX - panStart.x);
    zoom.y = panOrigin.y + (e.clientY - panStart.y);
    apply();
  });
  document.addEventListener('mouseup', () => {
    if (!panning) return;
    panning = false;
    apply();
  });
  content.addEventListener('dblclick', () => {
    if (!target()) return;
    zoom = zoom.scale > 1 ? { scale: 1, x: 0, y: 0 } : { ...zoom, scale: 2.5 };
    apply();
  });

  return { open, close };
}
