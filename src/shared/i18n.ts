// i18n with an explicit language override. chrome.i18n always follows the
// browser UI language, so when the user picks a language in Settings the
// matching _locales/<lang>/messages.json is loaded and formatted by hand.

import type { LangSetting } from './types';

export interface CatalogEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
export type Catalog = Record<string, CatalogEntry>;

export const SUPPORTED_LANGS = ['ru', 'en', 'uk'] as const;

/** Applies Chrome-style $NAME$ placeholders ($1, $2… in `content`) and `$$` escapes. */
export function formatMessage(entry: CatalogEntry, subs: string[] = []): string {
  let text = entry.message;
  const placeholders = entry.placeholders ?? {};
  for (const name of Object.keys(placeholders)) {
    const content = placeholders[name]?.content ?? '';
    const value = content.replace(/\$(\d)/g, (_, d: string) => subs[Number(d) - 1] ?? '');
    // Function replacer: `value` may itself contain `$&`, `$1`… which a string
    // replacement would interpret.
    text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), () => value);
  }
  return text.replace(/\$\$/g, '$');
}

let catalog: Catalog | null = null;

/**
 * Language whose catalog must be loaded by hand, or null when chrome.i18n
 * already gives the right one. "auto" with a browser language we don't ship
 * means English — chrome.i18n would fall back to default_locale (ru).
 */
export function catalogLangFor(setting: LangSetting, uiLanguage: string): (typeof SUPPORTED_LANGS)[number] | null {
  if (setting !== 'auto') return setting;
  const ui = uiLanguage.slice(0, 2).toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(ui) ? null : 'en';
}

export async function loadCatalog(setting: LangSetting): Promise<void> {
  const lang = catalogLangFor(setting, chrome.i18n.getUILanguage?.() ?? 'en');
  if (lang === null) {
    catalog = null;
    return;
  }
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    catalog = (await res.json()) as Catalog;
  } catch {
    catalog = null;
  }
}

export function setCatalog(c: Catalog | null): void {
  catalog = c;
}

export function t(key: string, subs?: string[]): string {
  const entry = catalog?.[key];
  if (entry) return formatMessage(entry, subs);
  return chrome.i18n.getMessage(key, subs) || key;
}

export function localizeDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
}
