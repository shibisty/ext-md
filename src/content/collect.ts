// Finds images/videos on the page: <img>, computed CSS backgrounds, <video>
// and <source>, same-origin stylesheet rules (incl. @media/@supports/@import),
// and media seen in network traffic. Tags DOM elements with data-mg-id for
// the hover highlight.

import { absolute, classify, extractCssUrls, firstCssUrl } from '../shared/media';
import type { FoundImage, FoundVideo, ScanData } from '../shared/types';
import type { NetworkEntry } from './network';

const CSS_PROPS = ['background', 'background-image', 'border-image-source', 'list-style-image', 'content', 'mask-image'];
const MIN_BG_BOX = 40;
const MAX_INLINE_DATA_URL = 2_000_000;

let mgCounter = 0;
function nextMgId(): string {
  mgCounter += 1;
  return `mg-${mgCounter}`;
}

function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('about:blank')) return null;
  return trimmed;
}

export function bgImageUrl(el: Element, win: Window = window): string | null {
  return firstCssUrl(win.getComputedStyle(el).backgroundImage);
}

/** Walks a rule list recursively (grouping rules and @import). */
function walkRules(rules: CSSRuleList, visit: (style: CSSStyleDeclaration, base: string) => void, base: string, depth = 0): void {
  if (depth > 8) return;
  for (const rule of Array.from(rules)) {
    const r = rule as CSSRule & { style?: CSSStyleDeclaration; cssRules?: CSSRuleList; styleSheet?: CSSStyleSheet | null };
    if (r.style) visit(r.style, base);
    if (r.cssRules) walkRules(r.cssRules, visit, base, depth + 1);
    if (r.styleSheet) {
      try {
        const imported = r.styleSheet;
        walkRules(imported.cssRules, visit, imported.href ?? base, depth + 1);
      } catch {
        /* cross-origin @import — the background can't see it either; skip */
      }
    }
  }
}

export interface CollectOptions {
  doc?: Document;
  win?: Window;
  network?: NetworkEntry[];
}

export function collectMedia({ doc = document, win = window, network = [] }: CollectOptions = {}): ScanData {
  const seenImages = new Set<string>();
  const seenVideos = new Set<string>();
  const images: FoundImage[] = [];
  const videos: FoundVideo[] = [];
  const externalSheets = new Set<string>();
  const base = doc.baseURI;

  const addImage = (img: FoundImage) => {
    if (seenImages.has(img.url)) return;
    seenImages.add(img.url);
    images.push(img);
  };
  const addVideo = (vid: FoundVideo) => {
    if (seenVideos.has(vid.url)) return;
    seenVideos.add(vid.url);
    videos.push(vid);
  };
  const addByType = (url: string, source: 'css-file' | 'network') => {
    const type = classify(url);
    if (type === 'image') addImage({ url, source, width: null, height: null, alt: '' });
    else if (type === 'video') addVideo({ url, source, width: null, height: null, poster: null, duration: null, isBlob: false });
  };

  // <img>
  doc.querySelectorAll('img').forEach((img) => {
    const raw = sanitizeUrl(img.currentSrc || img.getAttribute('src'));
    if (!raw) return;
    const mgId = nextMgId();
    img.setAttribute('data-mg-id', mgId);
    addImage({
      url: absolute(raw, base),
      width: img.naturalWidth || null,
      height: img.naturalHeight || null,
      alt: img.alt || '',
      source: 'img',
      mgId,
    });
  });

  // CSS background-image via computed style
  doc.querySelectorAll('body *').forEach((el) => {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_BG_BOX || rect.height < MIN_BG_BOX) return;
    const raw = bgImageUrl(el, win);
    if (!raw) return;
    const url = absolute(raw, base);
    if (url.startsWith('data:') && url.length > MAX_INLINE_DATA_URL) return;
    const mgId = nextMgId();
    el.setAttribute('data-mg-id', mgId);
    addImage({ url, width: Math.round(rect.width), height: Math.round(rect.height), alt: '', source: 'css-background', mgId });
  });

  // <video> + <source>
  doc.querySelectorAll('video').forEach((video) => {
    const candidates = new Set<string>();
    const direct = sanitizeUrl(video.currentSrc || video.getAttribute('src'));
    if (direct) candidates.add(direct);
    video.querySelectorAll('source').forEach((s) => {
      const src = sanitizeUrl(s.getAttribute('src'));
      if (src) candidates.add(src);
    });
    if (candidates.size === 0) return;
    const mgId = nextMgId();
    video.setAttribute('data-mg-id', mgId);

    // Custom players (Instagram/TikTok…) have no poster and report 0×0 until
    // a frame is decoded: fall back to the on-screen box and a frame snapshot.
    let width: number | null = video.videoWidth || null;
    let height: number | null = video.videoHeight || null;
    let approxSize = false;
    if (!width || !height) {
      const rect = video.getBoundingClientRect();
      if (rect.width > 10 && rect.height > 10) {
        width = Math.round(rect.width);
        height = Math.round(rect.height);
        approxSize = true;
      }
    }

    let poster: string | null = video.poster ? absolute(video.poster, base) : null;
    if (!poster && video.readyState >= 2) poster = snapshotFrame(doc, video, width, height);

    for (const raw of candidates) {
      const url = raw.startsWith('blob:') ? raw : absolute(raw, base);
      addVideo({
        url,
        width,
        height,
        approxSize,
        poster,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        isBlob: url.startsWith('blob:'),
        source: 'video',
        mgId,
      });
    }
  });

  // Stylesheets: same-origin parsed here, cross-origin handed to the background.
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) externalSheets.add(sheet.href);
      continue;
    }
    if (!rules) continue;
    walkRules(
      rules,
      (style, sheetBase) => {
        for (const prop of CSS_PROPS) {
          const val = style.getPropertyValue(prop);
          if (!val || val === 'none') continue;
          for (const url of extractCssUrls(val, sheetBase)) addByType(url, 'css-file');
        }
      },
      sheet.href ?? base,
    );
  }

  // Network (lazy-loaded or already removed from the DOM)
  for (const entry of network) addByType(entry.url, 'network');

  return {
    pageUrl: doc.location?.href ?? '',
    pageTitle: doc.title,
    images,
    videos,
    externalSheets: [...externalSheets],
  };
}

function snapshotFrame(doc: Document, video: HTMLVideoElement, width: number | null, height: number | null): string | null {
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = video.videoWidth || width || 320;
    canvas.height = video.videoHeight || height || 180;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // Cross-origin video without CORS taints the canvas — no thumbnail.
    return null;
  }
}
