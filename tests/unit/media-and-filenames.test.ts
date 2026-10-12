import { describe, expect, it } from 'vitest';
import { baseNameFor, safeName } from '../../src/shared/filenames';
import { classify, extFromMime, extractCssUrls, firstCssUrl, guessFormat, hostOf, isHttpUrl } from '../../src/shared/media';

describe('classify', () => {
  it.each([
    ['https://a.com/x.JPG', 'image'],
    ['https://a.com/x.webp?w=200', 'image'],
    ['https://a.com/x.svg#icon', 'image'],
    ['https://a.com/clip.mp4', 'video'],
    ['https://a.com/clip.webm?t=1', 'video'],
    ['https://a.com/page.html', null],
    ['https://a.com/jpg/notes', null],
  ])('%s → %s', (url, type) => expect(classify(url)).toBe(type));
});

describe('extractCssUrls', () => {
  const base = 'https://cdn.example.com/css/site.css';
  it('resolves relative URLs against the stylesheet and skips data:', () => {
    const css = `.a{background:url(../img/a.png)} .b{background:url("b.jpg")} .c{background:url('data:image/png;base64,AAA')}`;
    expect(extractCssUrls(css, base)).toEqual(['https://cdn.example.com/img/a.png', 'https://cdn.example.com/css/b.jpg']);
  });
  it('ignores url() inside comments', () => {
    expect(extractCssUrls('/* .x{background:url(old.png)} */ .y{background:url(new.png)}', base)).toEqual([
      'https://cdn.example.com/css/new.png',
    ]);
  });
  it('handles whitespace inside url( )', () => {
    expect(extractCssUrls('a{b:url(  "x.gif"  )}', base)).toEqual(['https://cdn.example.com/css/x.gif']);
  });
});

describe('firstCssUrl', () => {
  it('reads the first url of a computed value', () => {
    expect(firstCssUrl('url("https://a.com/1.png"), url(2.png)')).toBe('https://a.com/1.png');
    expect(firstCssUrl('none')).toBeNull();
    expect(firstCssUrl('linear-gradient(red, blue)')).toBeNull();
  });
});

describe('guessFormat / extFromMime', () => {
  it('prefers MIME, handles parameters', () => {
    expect(extFromMime('image/jpeg; charset=binary')).toBe('jpg');
    expect(guessFormat('https://a.com/x', 'image', 'image/webp')).toBe('WEBP');
  });
  it('data:, blob: and path extensions', () => {
    expect(guessFormat('data:image/svg+xml;base64,AAA', 'image')).toBe('SVG');
    expect(guessFormat('blob:https://a.com/uuid', 'video')).toBe('STREAM');
    expect(guessFormat('blob:https://a.com/uuid', 'image')).toBe('BLOB');
    expect(guessFormat('https://a.com/p/photo.jpeg?x=1', 'image')).toBe('JPEG');
    expect(guessFormat('https://a.com/p/photo', 'video')).toBe('VIDEO');
  });
});

describe('hostOf / isHttpUrl', () => {
  it('works with bad input', () => {
    expect(hostOf('https://www.site.org/a')).toBe('www.site.org');
    expect(hostOf(undefined)).toBe('page');
    expect(isHttpUrl('chrome://extensions')).toBe(false);
    expect(isHttpUrl('HTTPS://x.com')).toBe(true);
  });
});

describe('safeName', () => {
  it('replaces characters Windows forbids', () => {
    expect(safeName('a<b>:c"d/e\\f|g?h*i.jpg', 'x')).toBe('a_b__c_d_e_f_g_h_i.jpg');
  });
  it('strips trailing dots/spaces and protects reserved names', () => {
    expect(safeName('photo. . ', 'x')).toBe('photo');
    expect(safeName('CON.jpg', 'x')).toBe('_CON.jpg');
    expect(safeName('   ', 'fallback')).toBe('fallback');
  });
  it('truncates very long names but keeps the extension', () => {
    const name = safeName(`${'a'.repeat(300)}.webp`, 'x');
    expect(name.length).toBe(150);
    expect(name.endsWith('.webp')).toBe(true);
  });
});

describe('baseNameFor', () => {
  it('uses the decoded last path segment', () => {
    expect(baseNameFor({ url: 'https://a.com/img/%D0%BA%D1%96%D1%82.png?x=1', type: 'image' }, 0)).toBe('кіт.png');
  });
  it('adds an extension when the path has none', () => {
    expect(baseNameFor({ url: 'https://a.com/photo', type: 'image', mime: 'image/webp' }, 0)).toBe('photo.webp');
    expect(baseNameFor({ url: 'https://a.com/', type: 'video' }, 2)).toBe('video_3.mp4');
  });
  it('names blob videos by MIME, never ".stream"', () => {
    expect(baseNameFor({ url: 'blob:https://a.com/uuid', type: 'video', mime: 'video/webm' }, 0)).toBe('video_1.webm');
    expect(baseNameFor({ url: 'blob:https://a.com/uuid', type: 'video' }, 0)).toBe('video_1.mp4');
  });
  it('takes the extension from a data: URL', () => {
    expect(baseNameFor({ url: 'data:image/png;base64,AAA', type: 'image' }, 4)).toBe('image_5.png');
  });
  it('survives malformed percent-encoding', () => {
    expect(baseNameFor({ url: 'https://a.com/bad%E0%A4%A.jpg', type: 'image' }, 0)).toBe('bad%E0%A4%A.jpg');
  });
});
