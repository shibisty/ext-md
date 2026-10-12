import { beforeEach, describe, expect, it, vi } from 'vitest';
import { base64ToBytes } from '../../src/shared/base64';
import { STREAM_CHUNK_BYTES, nextBlobChunk, openBlobStream } from '../../src/content/blob-stream';
import { collectMedia } from '../../src/content/collect';
import { clearHighlight, highlightByMgId, highlightByUrl } from '../../src/content/highlight';
import { NetworkTracker, routeOf } from '../../src/content/network';

function setBox(el: Element, width: number, height: number) {
  el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
}

describe('collectMedia', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('finds <img>, <video>/<source>, CSS rules and network media without duplicates', () => {
    document.head.innerHTML = `<style>
      .hero { background-image: url("/img/hero.jpg"); }
      @media (min-width: 1px) { .nested { background: url(/img/nested.webp) no-repeat; } }
      .icon { background: url(/img/hero.jpg); }
    </style>`;
    document.body.innerHTML = `
      <img src="/img/a.png" alt="A">
      <img src="/img/a.png">
      <img src="">
      <video src="/v/clip.mp4" poster="/v/poster.jpg"><source src="/v/clip.webm"></video>`;

    const data = collectMedia({
      network: [
        { url: 'http://localhost:3000/lazy/late.gif', type: 'image', startTime: 1 },
        { url: 'http://localhost:3000/img/a.png', type: 'image', startTime: 1 },
      ],
    });

    expect(data.images.map((i) => [i.url.replace(location.origin, ''), i.source])).toEqual([
      ['/img/a.png', 'img'],
      ['/img/hero.jpg', 'css-file'],
      ['/img/nested.webp', 'css-file'],
      ['/lazy/late.gif', 'network'],
    ]);
    expect(data.images[0]!.alt).toBe('A');
    expect(data.videos.map((v) => v.url.replace(location.origin, ''))).toEqual(['/v/clip.mp4', '/v/clip.webm']);
    expect(data.videos[0]!.poster).toBe(`${location.origin}/v/poster.jpg`);
    expect(data.videos[0]!.mgId).toBe(data.videos[1]!.mgId);
    expect(document.querySelector('video')!.getAttribute('data-mg-id')).toBe(data.videos[0]!.mgId);
  });

  it('picks computed backgrounds only for elements at least 40×40', () => {
    document.body.innerHTML = `<div id="big" style="background-image:url(/bg/big.png)"></div><div id="tiny" style="background-image:url(/bg/tiny.png)"></div>`;
    setBox(document.getElementById('big')!, 300, 200);
    setBox(document.getElementById('tiny')!, 10, 10);
    const data = collectMedia();
    expect(data.images.map((i) => [i.url.replace(location.origin, ''), i.source, i.width])).toEqual([['/bg/big.png', 'css-background', 300]]);
  });

  it('marks blob: videos and uses the on-screen box when the size is unknown', () => {
    document.body.innerHTML = `<video src="blob:http://localhost:3000/abc"></video>`;
    setBox(document.querySelector('video')!, 320, 180);
    const [v] = collectMedia().videos;
    expect(v).toMatchObject({ url: 'blob:http://localhost:3000/abc', isBlob: true, width: 320, height: 180, approxSize: true });
  });
});

describe('NetworkTracker', () => {
  it('keeps entries across rescans (no clearing)', () => {
    const t = new NetworkTracker('https://a.com/');
    t.add('https://a.com/1.jpg', 10);
    t.add('https://a.com/app.js', 11);
    expect(t.snapshot('https://a.com/', 100).map((e) => e.url)).toEqual(['https://a.com/1.jpg']);
    expect(t.snapshot('https://a.com/', 200).map((e) => e.url)).toEqual(['https://a.com/1.jpg']);
  });

  it('drops the old route after a navigation event', () => {
    const t = new NetworkTracker('https://a.com/');
    t.add('https://a.com/old.jpg', 10);
    t.markNavigation(50);
    t.add('https://a.com/new.jpg', 60);
    expect(t.snapshot('https://a.com/page2', 100).map((e) => e.url)).toEqual(['https://a.com/new.jpg']);
  });

  it('without navigation events, a URL change cuts off what preceded the previous scan', () => {
    const t = new NetworkTracker('https://a.com/');
    t.add('https://a.com/old.jpg', 10);
    t.snapshot('https://a.com/', 100);
    t.add('https://a.com/new.jpg', 150);
    expect(t.snapshot('https://a.com/page2', 200).map((e) => e.url)).toEqual(['https://a.com/new.jpg']);
  });

  it('routeOf ignores the fragment', () => {
    expect(routeOf('https://a.com/p?x=1#top')).toBe('https://a.com/p?x=1');
    expect(routeOf('https://a.com/p')).toBe('https://a.com/p');
  });

  it('skips loads that failed with an HTTP error', () => {
    const t = new NetworkTracker('https://a.com/');
    t.add('https://a.com/favicon.ico', 1, 404);
    t.add('https://a.com/ok.png', 1, 200);
    t.add('https://cdn.b.com/opaque.png', 1, 0);
    expect(t.snapshot('https://a.com/', 2).map((e) => e.url)).toEqual(['https://a.com/ok.png', 'https://cdn.b.com/opaque.png']);
  });

  it('refreshes the timestamp when a URL is loaded again', () => {
    const t = new NetworkTracker('https://a.com/');
    t.add('https://a.com/shared.png', 10);
    t.markNavigation(50);
    t.add('https://a.com/shared.png', 60);
    expect(t.snapshot('https://a.com/', 70)).toHaveLength(1);
  });
});

describe('blob streaming', () => {
  it('re-batches reader chunks into ≤ STREAM_CHUNK_BYTES messages and ends with done', async () => {
    const total = STREAM_CHUNK_BYTES * 2 + 123;
    const source = new Uint8Array(total).map((_, i) => i % 251);
    const piece = 1024 * 1024 + 7; // odd-sized reader chunks
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let o = 0; o < total; o += piece) controller.enqueue(source.slice(o, o + piece));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'video/mp4' } })));

    const { id, mime } = await openBlobStream('blob:x');
    expect(mime).toBe('video/mp4');
    const received: Uint8Array[] = [];
    for (;;) {
      const next = await nextBlobChunk(id);
      if (next.done) break;
      const bytes = base64ToBytes(next.base64);
      expect(bytes.length).toBeLessThanOrEqual(STREAM_CHUNK_BYTES);
      received.push(bytes);
    }
    expect(received.map((r) => r.length)).toEqual([STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, 123]);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const r of received) {
      joined.set(r, o);
      o += r.length;
    }
    // Buffer.equals: toEqual on multi-MB typed arrays is pathologically slow.
    expect(Buffer.from(joined).equals(Buffer.from(source))).toBe(true);
    // A finished (or swept) stream is an error, never a silent "done".
    await expect(nextBlobChunk(id)).rejects.toThrow('stream-expired');
    vi.unstubAllGlobals();
  });

  it('reports stream-unavailable when the blob cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(openBlobStream('blob:mse')).rejects.toThrow('stream-unavailable');
    vi.unstubAllGlobals();
  });
});

describe('highlight', () => {
  it('outlines by data-mg-id and clears', () => {
    document.body.innerHTML = '<img data-mg-id="mg-7">';
    expect(highlightByMgId('mg-7')).toBe(true);
    expect(document.querySelector('img')!.style.outline).toContain('3px solid');
    clearHighlight();
    expect(document.querySelector('img')!.style.outline).toBe('');
    expect(highlightByMgId('mg-404')).toBe(false);
  });

  it('outlines every element whose background matches the URL', () => {
    document.body.innerHTML = '<div style="background-image:url(/x.png)"></div><div style="background-image:url(/x.png)"></div><div></div>';
    expect(highlightByUrl(`${location.origin}/x.png`)).toBe(2);
    clearHighlight();
    expect(document.querySelectorAll('.__mg_highlight_fallback__')).toHaveLength(0);
  });
});
