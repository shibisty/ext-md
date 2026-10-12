// Popup and side panel entry (same UI; the panel has class="panel" on <body>).

import { IS_FIREFOX, sidebarAction } from '../../shared/env';
import { loadCatalog, localizeDom, t } from '../../shared/i18n';
import { hostOf, isHttpUrl } from '../../shared/media';
import { sendToBackground, sendToTab } from '../../shared/messages';
import { loadSelection, saveSelection } from '../../shared/selection-cache';
import { DEFAULT_VIEW_STATE, loadSettings, loadViewState, saveSetting, saveViewState, type SortKey, type ViewState } from '../../shared/settings';
import { errorMessage, type Settings } from '../../shared/types';
import { isDirectoryModeSupported } from '../fs-handle';
import { initSettingsForm, type SettingsForm } from '../settings-form';
import { applyTheme, currentResolvedTheme } from '../theme';
import { createContextMenu, type MenuEntry } from './context-menu';
import { DirectoryUnavailableError, downloadToDirectory, resolveDirectory } from './directory-download';
import { createLightbox } from './lightbox';
import { buildItems, computeVisibleItems, counts, outcomeStatus, selectionMap, tabIdFromSearch, type PopupItem } from './state';
import { MediaTable } from './table';

const TRIGGER_FLAG = 'mg_trigger_download_all';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  loadingState: $('loadingState'),
  emptyState: $('emptyState'),
  emptyStateText: $('emptyStateText'),
  tableWrap: $('tableWrap'),
  tableBody: $('tableBody'),
  mediaTable: $('mediaTable'),
  selectAllCheckbox: $<HTMLInputElement>('selectAllCheckbox'),
  selectAllLabel: $('selectAllLabel'),
  downloadBtn: $<HTMLButtonElement>('downloadBtn'),
  statusLine: $('statusLine'),
  refreshBtn: $('refreshBtn'),
  settingsBtn: $('settingsBtn'),
  sidePanelBtn: document.getElementById('sidePanelBtn'),
  themeBtn: $('themeBtn'),
  tabs: $('tabs'),
  sizeMin: $<HTMLInputElement>('sizeMin'),
  sizeMax: $<HTMLInputElement>('sizeMax'),
  sizeFilterClear: $('sizeFilterClear'),
  mainView: $('mainView'),
  settingsView: $('settingsView'),
  countAll: $('countAll'),
  countImages: $('countImages'),
  countVideos: $('countVideos'),
};

const isPanel = document.body.classList.contains('panel');
const explicitTabId = tabIdFromSearch(location.search);

let items: PopupItem[] = [];
let view: ViewState = { ...DEFAULT_VIEW_STATE };
let settings: Settings;
let activeTabId: number | null = null;
let pageHost = 'page';
let pageUrl = '';
let downloading = false;
let scanSeq = 0;

// ---------- status ----------

function setStatus(text: string, kind?: 'success' | 'error'): void {
  els.statusLine.textContent = text;
  els.statusLine.className = `status-line${kind ? ` ${kind}` : ''}`;
}

function showState(state: 'loading' | 'empty' | 'table', emptyText?: string): void {
  els.loadingState.classList.toggle('hidden', state !== 'loading');
  els.emptyState.classList.toggle('hidden', state !== 'empty');
  els.tableWrap.classList.toggle('hidden', state !== 'table');
  if (emptyText) els.emptyStateText.textContent = emptyText;
}

// ---------- persistence (debounced) ----------

let selectionTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSelectionSave(): void {
  if (!pageUrl) return;
  const url = pageUrl;
  const map = selectionMap(items);
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => void saveSelection(url, map).catch(() => {}), 300);
}

let viewTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleViewSave(): void {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => void saveViewState(view).catch(() => {}), 200);
}

// ---------- rendering ----------

const lightbox = createLightbox($('lightbox'), $('lightboxContent'), $('lightboxClose'));
const contextMenu = createContextMenu();

const table = new MediaTable(els.tableBody, {
  onSelectionChange: () => {
    refreshCounts();
    scheduleSelectionSave();
  },
  onOpen: (item) => void lightbox.open(item, activeTabId),
  onContextMenu: (item, x, y) => contextMenu.open(x, y, menuFor(item)),
  onHover: (item) => {
    if (activeTabId === null) return;
    const msg = item ? ({ type: 'MG_HIGHLIGHT', mgId: item.mgId, url: item.url } as const) : ({ type: 'MG_CLEAR_HIGHLIGHT' } as const);
    sendToTab(activeTabId, msg).catch(() => {});
  },
});

function render(): void {
  table.render(computeVisibleItems(items, view));
  updateSortIndicators();
  refreshCounts();
}

function updateSortIndicators(): void {
  els.mediaTable.querySelectorAll<HTMLElement>('th.sortable').forEach((th) => {
    const indicator = th.querySelector('.sort-indicator');
    if (!indicator) return;
    indicator.textContent = th.dataset.sort === view.sortKey ? (view.sortDir === 1 ? '▲' : '▼') : '';
  });
}

function refreshCounts(): void {
  const c = counts(items);
  els.countAll.textContent = String(c.total);
  els.countImages.textContent = String(c.images);
  els.countVideos.textContent = String(c.videos);
  els.selectAllLabel.textContent = t('selectedLabel', [String(c.selected), String(c.total)]);
  els.selectAllCheckbox.checked = c.total > 0 && c.selected === c.total;
  els.selectAllCheckbox.indeterminate = c.selected > 0 && c.selected < c.total;
  els.downloadBtn.textContent = t('downloadButton', [String(c.selected)]);
  els.downloadBtn.disabled = downloading || c.selected === 0;
}

function syncViewControls(): void {
  els.tabs.querySelectorAll<HTMLElement>('.tab').forEach((tb) => tb.classList.toggle('active', tb.dataset.filter === view.filter));
  els.sizeMin.value = view.sizeMin;
  els.sizeMax.value = view.sizeMax;
}

function syncThemeButton(): void {
  els.themeBtn.textContent = currentResolvedTheme() === 'light' ? '🌙' : '☀';
}

// ---------- context menu ----------

function menuFor(item: PopupItem): MenuEntry[] {
  const entries: MenuEntry[] = [
    { label: t('ctxSaveThis'), action: () => void handleDownload([item]) },
    {
      label: t('ctxSelectOnly'),
      action: () => {
        for (const it of items) it.selected = it === item;
        render();
        scheduleSelectionSave();
      },
    },
    { label: t('ctxOpenLarge'), action: () => void lightbox.open(item, activeTabId) },
  ];
  if (isHttpUrl(item.url)) entries.push({ label: t('ctxOpenTab'), action: () => void chrome.tabs.create({ url: item.url }) });
  entries.push({
    label: t('ctxCopyLink'),
    action: async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        setStatus(t('ctxLinkCopied'), 'success');
      } catch {
        /* clipboard denied */
      }
    },
  });
  return entries;
}

// ---------- scanning ----------

async function resolveTab(): Promise<chrome.tabs.Tab | undefined> {
  if (explicitTabId !== null) return chrome.tabs.get(explicitTabId).catch(() => undefined);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scanPage(): Promise<void> {
  const seq = ++scanSeq;
  // Drop the previous page's items right away: the side panel rescans on tab
  // switches, and Download must never act on the old page's list meanwhile.
  items = [];
  table.render([]);
  refreshCounts();
  showState('loading');
  setStatus('');

  const tab = await resolveTab();
  if (seq !== scanSeq) return;
  if (!tab?.id) {
    showState('empty', t('noActiveTab'));
    setStatus(t('noActiveTab'), 'error');
    return;
  }
  activeTabId = tab.id;
  pageUrl = tab.url ?? '';
  pageHost = hostOf(pageUrl);

  if (!isHttpUrl(pageUrl)) {
    items = [];
    refreshCounts();
    showState('empty', t('emptyUnavailable'));
    return;
  }

  let response;
  try {
    response = await sendToBackground({ type: 'MG_SCAN_TAB', tabId: tab.id });
  } catch (e) {
    response = { ok: false as const, error: errorMessage(e) };
  }
  if (seq !== scanSeq) return;

  if (!response?.ok) {
    items = [];
    refreshCounts();
    setStatus(t('scanErrorPrefix') + (response?.error ?? ''), 'error');
    showState('empty', t('scanFailed'));
    return;
  }

  const cache = await loadSelection(pageUrl).catch(() => null);
  if (seq !== scanSeq) return;
  items = buildItems(response.data, cache);
  showState(items.length ? 'table' : 'empty', items.length ? undefined : t('emptyDefault'));
  render();
  await maybeAutoDownloadFromHotkey();
}

// ---------- downloading ----------

async function handleDownload(only?: PopupItem[]): Promise<void> {
  const selected = only ?? items.filter((it) => it.selected);
  if (selected.length === 0 || activeTabId === null || downloading) return;

  downloading = true;
  els.downloadBtn.disabled = true;
  setStatus(t('statusDownloading', [String(selected.length)]));
  settings = await loadSettings();

  try {
    if (settings.mg_download_mode === 'directory') {
      if (!isDirectoryModeSupported()) {
        setStatus(t('dirUnsupportedNote'), 'error');
        return;
      }
      let root: FileSystemDirectoryHandle;
      try {
        root = await resolveDirectory();
      } catch (e) {
        if (e instanceof DirectoryUnavailableError) {
          setStatus(t('statusNoStart'), 'error');
          return;
        }
        throw e;
      }
      const outcome = await downloadToDirectory(root, selected, pageHost, activeTabId, (remaining) =>
        setStatus(t('statusDownloading', [String(remaining)])),
      );
      const s = outcomeStatus(outcome.done, outcome.failed, outcome.streamFailed);
      setStatus(t(s.key, s.subs), s.kind);
      return;
    }

    const response = await sendToBackground({
      type: 'MG_DOWNLOAD_ITEMS',
      tabId: activeTabId,
      items: selected.map((it) => ({ url: it.url, type: it.type, mime: it.mime ?? null })),
      pageHost,
      saveAs: false,
    });
    if (!response?.ok) {
      setStatus(t('statusNoStart'), 'error');
      return;
    }
    const failed = response.results.filter((r) => !r.ok);
    const streamFailed = failed.filter((r) => r.error === 'stream-unavailable').length;
    const s = outcomeStatus(response.results.length - failed.length, failed.length, streamFailed);
    setStatus(t(s.key, s.subs), s.kind);
  } catch (e) {
    setStatus(t('statusError', [errorMessage(e)]), 'error');
  } finally {
    downloading = false;
    refreshCounts();
  }
}

async function maybeAutoDownloadFromHotkey(): Promise<void> {
  if (isPanel) return; // only the popup is opened programmatically by the hotkey
  try {
    const flag = await chrome.storage.session.get(TRIGGER_FLAG);
    if (flag[TRIGGER_FLAG]) {
      await chrome.storage.session.remove(TRIGGER_FLAG);
      await handleDownload();
    }
  } catch {
    /* storage.session unavailable */
  }
}

// ---------- settings view ----------

let settingsForm: SettingsForm | null = null;
function getSettingsForm(): SettingsForm {
  settingsForm ??= initSettingsForm(els.settingsView, settings, {
    onLanguageChanged: () => render(),
    onChanged: (next) => {
      settings = next;
      syncThemeButton();
    },
  });
  return settingsForm;
}

function toggleSettingsView(): void {
  const opening = els.settingsView.classList.contains('hidden');
  els.mainView.classList.toggle('hidden', opening);
  els.settingsView.classList.toggle('hidden', !opening);
  if (opening) void getSettingsForm().fill(settings);
}

// ---------- wiring ----------

function wire(): void {
  els.downloadBtn.addEventListener('click', () => void handleDownload());
  els.refreshBtn.addEventListener('click', () => void scanPage());
  els.settingsBtn.addEventListener('click', toggleSettingsView);

  els.themeBtn.addEventListener('click', () => {
    const next = currentResolvedTheme() === 'light' ? 'dark' : 'light';
    applyTheme(next);
    settings = { ...settings, mg_theme: next };
    syncThemeButton();
    void saveSetting('mg_theme', next);
  });

  if (els.sidePanelBtn) {
    const sidebar = sidebarAction();
    if (IS_FIREFOX ? !sidebar : !chrome.sidePanel) {
      els.sidePanelBtn.classList.add('hidden');
    } else {
      els.sidePanelBtn.addEventListener('click', () => {
        // Must run synchronously inside the click (user gesture) — no awaits before open().
        if (!IS_FIREFOX && activeTabId === null) return;
        const opened = IS_FIREFOX ? sidebar!.open() : chrome.sidePanel.open({ tabId: activeTabId! });
        opened.then(() => window.close()).catch(() => {});
      });
    }
  }

  els.selectAllCheckbox.addEventListener('click', () => {
    const checked = els.selectAllCheckbox.checked;
    for (const it of computeVisibleItems(items, view)) it.selected = checked;
    render();
    scheduleSelectionSave();
  });

  els.mediaTable.querySelectorAll<HTMLElement>('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort as SortKey;
      view = view.sortKey === key ? { ...view, sortDir: view.sortDir === 1 ? -1 : 1 } : { ...view, sortKey: key, sortDir: 1 };
      render();
      scheduleViewSave();
    });
  });

  els.tabs.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('.tab');
    if (!btn) return;
    view = { ...view, filter: btn.dataset.filter as ViewState['filter'] };
    syncViewControls();
    render();
    scheduleViewSave();
  });

  for (const input of [els.sizeMin, els.sizeMax]) {
    input.addEventListener('input', () => {
      view = { ...view, sizeMin: els.sizeMin.value, sizeMax: els.sizeMax.value };
      render();
      scheduleViewSave();
    });
  }
  els.sizeFilterClear.addEventListener('click', () => {
    view = { ...view, sizeMin: '', sizeMax: '' };
    syncViewControls();
    render();
    scheduleViewSave();
  });

  // The side panel outlives tab switches and navigations — follow the active tab.
  if (isPanel && explicitTabId === null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rescanSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void scanPage(), 300);
    };
    chrome.tabs.onActivated.addListener(rescanSoon);
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === activeTabId && info.status === 'complete') rescanSoon();
    });
  }
}

// ---------- Firefox host permission ----------

const ALL_SITES = { origins: ['<all_urls>'] };

/**
 * In Firefox MV3 host permissions are optional: not granted at install before
 * Firefox 127, and revocable in about:addons at any time. Without them,
 * cross-origin stylesheets and the zip mode's cross-site fetches fail.
 */
async function checkHostPermission(): Promise<void> {
  if (!IS_FIREFOX || !chrome.permissions) return;
  const banner = $('permBanner');
  let granted = true;
  try {
    granted = await chrome.permissions.contains(ALL_SITES);
  } catch {
    /* treat as granted — nothing better to show */
  }
  banner.classList.toggle('hidden', granted);
  if (granted || banner.dataset.wired) return;
  banner.dataset.wired = '1';
  $('permGrantBtn').addEventListener('click', () => {
    // Must be called synchronously in the click (user gesture).
    chrome.permissions
      .request(ALL_SITES)
      .then((ok) => {
        if (!ok) return;
        banner.classList.add('hidden');
        void scanPage();
      })
      .catch(() => {});
  });
}

async function init(): Promise<void> {
  settings = await loadSettings();
  await loadCatalog(settings.mg_lang);
  localizeDom();
  applyTheme(settings.mg_theme);
  syncThemeButton();
  view = await loadViewState().catch(() => ({ ...DEFAULT_VIEW_STATE }));
  syncViewControls();
  wire();
  void checkHostPermission();
  await scanPage();
}

void init();
