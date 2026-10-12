import { readFileSync } from 'node:fs';
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

async function openFixture(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => (window as unknown as { lazyDone?: boolean }).lazyDone === true);
  // Drop the lazy image from the DOM: from now on only Resource Timing knows it.
  await page.evaluate(() => document.querySelectorAll('img[src*="lazy"]').forEach((el) => el.remove()));
}

async function rows(popup: Page): Promise<string[][]> {
  await expect(popup.locator('#tableBody tr').first()).toBeVisible();
  return popup.locator('#tableBody tr').evaluateAll((trs) =>
    trs.map((tr) => [tr.querySelector('.col-format')!.textContent ?? '', tr.querySelector('.col-size')!.textContent ?? '']),
  );
}

async function setSettings(sw: Worker, values: Record<string, unknown>): Promise<void> {
  await sw.evaluate((v) => chrome.storage.local.set(v), values);
}

async function completedDownloads(sw: Worker): Promise<chrome.downloads.DownloadItem[]> {
  return sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const items = await chrome.downloads.search({});
      if (items.length && items.every((d) => d.state !== 'in_progress')) return items;
      await new Promise((r) => setTimeout(r, 100));
    }
    return chrome.downloads.search({});
  });
}

test('scans every media source, deduplicated', async ({ context, servers, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const popup = await openPopup(page);
  const errors: string[] = [];
  popup.on('pageerror', (e) => errors.push(e.message));

  const table = await rows(popup);
  // photo.png (×2 in DOM → once), local-bg (same-origin sheet), inline-bg (computed),
  // cdn-bg (cross-origin sheet, fetched by background), lazy.png (network only),
  // clip.mp4 and the blob: video.
  await expect(popup.locator('#countImages')).toHaveText('5');
  await expect(popup.locator('#countVideos')).toHaveText('2');
  expect(table.map((r) => r[0]).sort()).toEqual(['MP4', 'PNG', 'PNG', 'PNG', 'PNG', 'PNG', 'STREAM']);
  await expect(popup.locator('#selectAllLabel')).toContainText('7');

  const urls = await popup.evaluate(async () => {
    // The table doesn't print URLs; read them back through the scan message.
    const tabId = Number(new URLSearchParams(location.search).get('tabId'));
    const res = await chrome.runtime.sendMessage({ type: 'MG_SCAN_TAB', tabId });
    return [...res.data.images, ...res.data.videos].map((i: { url: string; source: string }) => `${i.source} ${new URL(i.url).pathname}`);
  });
  expect(urls).toEqual(
    expect.arrayContaining([
      'img /img/photo.png',
      'css-background /img/inline-bg.png',
      'css-background /img/local-bg.png', // also in a same-origin rule — deduplicated
      'css-file /img/cdn-bg.png',
      'network /img/lazy.png',
      'video /media/clip.mp4',
    ]),
  );
  expect(urls).toHaveLength(7);
  expect(urls.some((u) => u.includes('commented'))).toBe(false);
  expect(urls.some((u) => u.includes('favicon'))).toBe(false); // 404 in the network log
  expect(errors).toEqual([]);
});

test('rescan keeps network-only items and leaves the page’s Resource Timing alone', async ({ context, servers, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const before = await page.evaluate(() => performance.getEntriesByType('resource').length);
  const popup = await openPopup(page);
  await rows(popup);
  await expect(popup.locator('#countAll')).toHaveText('7');
  await popup.click('#refreshBtn');
  await expect(popup.locator('#loadingState')).toBeHidden();
  await expect(popup.locator('#countAll')).toHaveText('7');
  expect(await page.evaluate(() => performance.getEntriesByType('resource').length)).toBeGreaterThanOrEqual(before);
});

test('hovering a row outlines the element on the page', async ({ context, servers, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const popup = await openPopup(page);
  await rows(popup);
  await popup.locator('#tableBody tr').first().hover();
  await expect.poll(() => page.locator('#photo').evaluate((el) => (el as HTMLElement).style.outline)).toContain('solid');
  await popup.mouse.move(0, 0);
  await popup.locator('#statusLine').hover();
  await expect.poll(() => page.locator('#photo').evaluate((el) => (el as HTMLElement).style.outline)).toBe('');
});

test('selection: click toggles, drag selects, filter + memory per page', async ({ context, servers, openPopup }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  let popup = await openPopup(page);
  await rows(popup);
  const trs = popup.locator('#tableBody tr');

  await trs.nth(0).locator('.col-size').click();
  await expect(trs.nth(0)).not.toHaveClass(/selected/);
  await expect(popup.locator('#downloadBtn')).toContainText('6');

  // drag over rows 1..3 → they flip to "unselected" (row 1's new state)
  const box1 = (await trs.nth(1).locator('.col-size').boundingBox())!;
  const box3 = (await trs.nth(3).locator('.col-size').boundingBox())!;
  await popup.mouse.move(box1.x + 5, box1.y + 5);
  await popup.mouse.down();
  await popup.mouse.move(box1.x + 5, box3.y + 5, { steps: 8 });
  await popup.mouse.up();
  await expect(popup.locator('#downloadBtn')).toContainText('3');

  // The drag must be over: hovering other rows no longer changes anything,
  // and the table is not being re-rendered behind our back.
  const mutations = await popup.evaluate(() => {
    const w = window as Window & { mgMutations?: number };
    w.mgMutations = 0;
    new MutationObserver(() => (w.mgMutations = (w.mgMutations ?? 0) + 1)).observe(document.getElementById('tableBody')!, { childList: true });
    return 0;
  });
  await trs.nth(5).hover();
  await trs.nth(0).hover();
  await popup.waitForTimeout(300);
  await expect(popup.locator('#downloadBtn')).toContainText('3');
  expect(await popup.evaluate(() => (window as Window & { mgMutations?: number }).mgMutations)).toBe(mutations);

  // shift+click: row 4 (anchor) .. row 6 → all take the clicked row's new state
  await trs.nth(4).locator('.col-size').click();
  await trs.nth(6).locator('.col-size').click({ modifiers: ['Shift'] });
  await expect(popup.locator('#downloadBtn')).toContainText('(0)');
  await trs.nth(4).locator('.col-size').click();
  await trs.nth(6).locator('.col-size').click({ modifiers: ['Shift'] });
  await expect(popup.locator('#downloadBtn')).toContainText('3');

  await popup.click('.tab[data-filter="video"]');
  await expect(trs).toHaveCount(2);

  // selection is remembered for this exact page URL
  await popup.waitForTimeout(500);
  await popup.close();
  popup = await openPopup(page);
  await rows(popup);
  await expect(popup.locator('#downloadBtn')).toContainText('3');
  await expect(popup.locator('.tab[data-filter="video"]')).toHaveClass(/active/);
});

test('"Downloads folder" mode: the main button downloads (regression: it used to get the click event)', async ({ context, servers, openPopup, worker, extensionId }) => {
  const sw = await worker();
  await setSettings(sw, { mg_download_mode: 'downloads', mg_subfolder: 'MG Test' });
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const popup = await openPopup(page);
  await rows(popup);

  const blobDownload = page.waitForEvent('download');
  await popup.click('#downloadBtn');
  await expect(popup.locator('#statusLine')).toHaveClass(/success/, { timeout: 20_000 });

  const native = await blobDownload; // blob: video, clicked inside the page
  expect(native.suggestedFilename()).toMatch(/^video_\d+\.mp4$/);
  const items = await completedDownloads(sw);
  // 6 through chrome.downloads + the blob: video clicked in the page (also listed by the browser).
  expect(items.length).toBe(7);
  expect(items.filter((d) => d.byExtensionId === extensionId)).toHaveLength(6);
  expect(items.every((d) => d.state === 'complete')).toBe(true);
});

test('".zip" mode: one valid archive with all selected files, including blob bytes', async ({ context, servers, openPopup, worker }) => {
  const sw = await worker();
  await setSettings(sw, { mg_download_mode: 'zip' });
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const popup = await openPopup(page);
  await rows(popup);
  await popup.click('#downloadBtn');
  await expect(popup.locator('#statusLine')).toHaveClass(/success/, { timeout: 20_000 });

  const [zip] = await completedDownloads(sw);
  expect(zip!.state).toBe('complete');
  const bytes = readFileSync(zip!.filename);
  const names: string[] = [];
  const sizes: number[] = [];
  for (let p = 0; p + 4 <= bytes.length && bytes.readUInt32LE(p) === 0x04034b50; ) {
    const size = bytes.readUInt32LE(p + 18);
    const nameLen = bytes.readUInt16LE(p + 26);
    names.push(bytes.subarray(p + 30, p + 30 + nameLen).toString('utf8'));
    sizes.push(size);
    p += 30 + nameLen + size;
  }
  expect(names).toHaveLength(7);
  const blobIndex = names.findIndex((n) => /video_\d+\.mp4$/.test(n));
  expect(sizes[blobIndex]).toBe(300000);
  expect(names.find((n) => n.endsWith('clip.mp4'))).toBeTruthy();
});

test('side panel and options page load and share settings', async ({ context, servers, openPopup, extensionId, worker }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const panel = await openPopup(page, 'sidepanel.html');
  await rows(panel);
  await expect(panel.locator('#sidePanelBtn')).toHaveCount(0);

  const options = await context.newPage();
  const errors: string[] = [];
  options.on('pageerror', (e) => errors.push(e.message));
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.check('input[name="dlmode"][value="zip"]');
  await options.selectOption('#langSelect', 'uk');
  await expect(options.locator('h2').first()).toHaveText('Мова');
  const sw = await worker();
  await expect.poll(() => sw.evaluate(() => chrome.storage.local.get(['mg_download_mode', 'mg_lang']))).toEqual({
    mg_download_mode: 'zip',
    mg_lang: 'uk',
  });

  // The popup's inline settings view reflects it.
  const popup = await openPopup(page);
  await popup.click('#settingsBtn');
  await expect(popup.locator('#settingsView input[value="zip"]')).toBeChecked();
  await expect(popup.locator('.tab[data-filter="all"] span').first()).toHaveText('Усі');
  expect(errors).toEqual([]);
});

test('theme toggle switches and persists', async ({ context, servers, openPopup, worker }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  const popup = await openPopup(page);
  const before = await popup.locator('html').getAttribute('data-theme');
  await popup.click('#themeBtn');
  const after = await popup.locator('html').getAttribute('data-theme');
  expect(after).not.toBe(before);
  const sw = await worker();
  await expect.poll(async () => (await sw.evaluate(() => chrome.storage.local.get('mg_theme'))).mg_theme).toBe(after);
});

test('scanning works when an orphaned install flag is left in the tab (after an extension update)', async ({ context, servers, openPopup, worker }) => {
  const page = await context.newPage();
  await openFixture(page, servers.page);
  // After an extension reload/update the old content script is dead, but its
  // install flag stays in the tab's isolated world. The old code re-injected,
  // hit the guard, and every scan failed with "Receiving end does not exist"
  // until the user reloaded the page. Reproduce exactly that state:
  const sw = await worker();
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab!.id! },
      func: () => {
        (window as Window & { __mediaGrabberInstalled?: boolean }).__mediaGrabberInstalled = true;
      },
    });
  }, page.url());

  const popup = await openPopup(page);
  await rows(popup);
  await expect(popup.locator('#countAll')).toHaveText('7');
});
