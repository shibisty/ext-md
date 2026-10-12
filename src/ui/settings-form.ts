// Settings form shared by the options page and the popup's inline settings
// view. Previously the same ~120 lines lived twice (options.js and popup.js)
// and had already drifted apart.

import { loadCatalog, localizeDom, t } from '../shared/i18n';
import { clearAllSelections } from '../shared/selection-cache';
import { saveSetting } from '../shared/settings';
import type { DownloadMode, LangSetting, Settings, ThemeSetting } from '../shared/types';
import { clearDirHandle, isDirectoryModeSupported, loadDirHandle, pickDirectory } from './fs-handle';
import { applyTheme } from './theme';
import { IS_FIREFOX } from '../shared/env';

export interface SettingsFormHooks {
  /** Called after the UI language changed and static text was re-localized. */
  onLanguageChanged?: () => void;
  /** Called with the new settings object after any change is saved. */
  onChanged?: (settings: Settings) => void;
}

export interface SettingsForm {
  /** Fills the controls from `settings` and refreshes folder/hotkey status. */
  fill(settings: Settings): Promise<void>;
}

function byId<T extends HTMLElement>(root: ParentNode, id: string): T {
  const el = root.querySelector<T>(`#${id}`);
  if (!el) throw new Error(`settings form: #${id} missing`);
  return el;
}

export function shortcutsPageUrl(): string {
  return IS_FIREFOX ? 'about:addons' : 'chrome://extensions/shortcuts';
}

export function initSettingsForm(root: ParentNode, initial: Settings, hooks: SettingsFormHooks = {}): SettingsForm {
  let settings = { ...initial };
  const langSelect = byId<HTMLSelectElement>(root, 'langSelect');
  const themeSelect = byId<HTMLSelectElement>(root, 'themeSelect');
  const subfolderInput = byId<HTMLInputElement>(root, 'subfolderInput');
  const pickDirBtn = byId<HTMLButtonElement>(root, 'pickDirBtn');
  const clearDirBtn = byId<HTMLButtonElement>(root, 'clearDirBtn');
  const dirStatus = byId<HTMLElement>(root, 'dirStatus');
  const directoryModeLabel = byId<HTMLElement>(root, 'directoryModeLabel');
  const dirUnsupportedNote = byId<HTMLElement>(root, 'dirUnsupportedNote');
  const hotkeyValue = byId<HTMLElement>(root, 'hotkeyValue');
  const changeHotkeyBtn = byId<HTMLButtonElement>(root, 'changeHotkeyBtn');
  const clearCacheBtn = byId<HTMLButtonElement>(root, 'clearCacheBtn');
  const savedNote = byId<HTMLElement>(root, 'savedNote');
  const radios = () => Array.from(root.querySelectorAll<HTMLInputElement>('input[name="dlmode"]'));

  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const flashSaved = () => {
    savedNote.textContent = t('savedText');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedNote.textContent = ''), 1500);
  };

  async function save<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    settings = { ...settings, [key]: value };
    await saveSetting(key, value);
    flashSaved();
    hooks.onChanged?.(settings);
  }

  async function refreshDirStatus(): Promise<void> {
    if (!isDirectoryModeSupported()) {
      directoryModeLabel.querySelector('input')!.disabled = true;
      dirUnsupportedNote.style.display = 'block';
      pickDirBtn.disabled = true;
      clearDirBtn.disabled = true;
      dirStatus.textContent = '';
      return;
    }
    dirUnsupportedNote.style.display = 'none';
    try {
      const handle = await loadDirHandle();
      dirStatus.textContent = handle ? `📁 ${handle.name}` : t('noFolderChosen');
    } catch {
      dirStatus.textContent = t('noFolderChosen');
    }
  }

  async function refreshHotkey(): Promise<void> {
    try {
      const commands = await chrome.commands.getAll();
      const cmd = commands.find((c) => c.name === 'download-all');
      hotkeyValue.textContent = cmd?.shortcut || t('hotkeyNotSet');
    } catch {
      hotkeyValue.textContent = t('hotkeyNotSet');
    }
  }

  pickDirBtn.addEventListener('click', async () => {
    try {
      await pickDirectory();
      await refreshDirStatus();
      const radio = radios().find((r) => r.value === 'directory');
      if (radio) radio.checked = true;
      await save('mg_download_mode', 'directory');
    } catch {
      /* picker cancelled */
    }
  });

  clearDirBtn.addEventListener('click', async () => {
    await clearDirHandle();
    await refreshDirStatus();
  });

  changeHotkeyBtn.addEventListener('click', () => {
    // Extensions can't change their shortcuts themselves — only the browser's page can.
    void chrome.tabs.create({ url: shortcutsPageUrl() });
  });

  clearCacheBtn.addEventListener('click', async () => {
    await clearAllSelections();
    flashSaved();
  });

  langSelect.addEventListener('change', async () => {
    const lang = langSelect.value as LangSetting;
    await save('mg_lang', lang);
    await loadCatalog(lang);
    localizeDom();
    await refreshDirStatus();
    await refreshHotkey();
    hooks.onLanguageChanged?.();
  });

  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value as ThemeSetting;
    applyTheme(theme);
    await save('mg_theme', theme);
  });

  subfolderInput.addEventListener('change', async () => {
    const value = subfolderInput.value.trim() || 'MediaGrabber';
    subfolderInput.value = value;
    await save('mg_subfolder', value);
  });

  for (const radio of radios()) {
    radio.addEventListener('change', async () => {
      if (radio.checked) await save('mg_download_mode', radio.value as DownloadMode);
    });
  }

  return {
    async fill(next: Settings) {
      settings = { ...next };
      langSelect.value = settings.mg_lang;
      themeSelect.value = settings.mg_theme;
      subfolderInput.value = settings.mg_subfolder;
      for (const r of radios()) r.checked = r.value === settings.mg_download_mode;
      // Best effort: these must never block the view from showing.
      await Promise.allSettled([refreshDirStatus(), refreshHotkey()]);
    },
  };
}
