import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogLangFor, formatMessage, setCatalog, t, type Catalog } from '../../src/shared/i18n';

const root = resolve(__dirname, '../..');
const load = (lang: string) => JSON.parse(readFileSync(resolve(root, `public/_locales/${lang}/messages.json`), 'utf8')) as Catalog;
const locales = { en: load('en'), ru: load('ru'), uk: load('uk') };

describe('formatMessage', () => {
  it('substitutes named placeholders', () => {
    const entry = locales.en.selectedLabel!;
    expect(formatMessage(entry, ['3', '10'])).toBe('Selected: 3 of 10');
  });
  it('does not interpret $& and friends inside substituted values', () => {
    const entry = { message: 'Error: $MSG$', placeholders: { msg: { content: '$1' } } };
    expect(formatMessage(entry, ['cost $& and $1'])).toBe('Error: cost $& and $1');
  });
  it('turns $$ into $', () => {
    expect(formatMessage({ message: 'Price $$5' })).toBe('Price $5');
  });
});

describe('catalogLangFor', () => {
  it('explicit choice wins; auto uses chrome.i18n for shipped languages, English otherwise', () => {
    expect(catalogLangFor('uk', 'de-DE')).toBe('uk');
    expect(catalogLangFor('auto', 'ru')).toBeNull();
    expect(catalogLangFor('auto', 'uk-UA')).toBeNull();
    expect(catalogLangFor('auto', 'de-DE')).toBe('en');
  });
});

describe('t()', () => {
  it('uses the explicit catalog when set, else chrome.i18n', () => {
    setCatalog(locales.uk);
    expect(t('tabAll')).toBe(locales.uk.tabAll!.message);
    setCatalog(null);
    expect(t('tabAll')).toBe('msg:tabAll');
  });
});

describe('locales', () => {
  const enKeys = Object.keys(locales.en).sort();

  it.each(['ru', 'uk'] as const)('%s has exactly the same keys as en', (lang) => {
    expect(Object.keys(locales[lang]).sort()).toEqual(enKeys);
  });

  it.each(['ru', 'uk'] as const)('%s uses the same placeholders as en', (lang) => {
    for (const key of enKeys) {
      const en = Object.keys(locales.en[key]!.placeholders ?? {}).sort();
      const other = Object.keys(locales[lang][key]!.placeholders ?? {}).sort();
      expect(other, `${lang}:${key}`).toEqual(en);
    }
  });

  it('every data-i18n key used in the HTML exists', () => {
    for (const file of ['popup.html', 'sidepanel.html', 'options.html']) {
      const html = readFileSync(resolve(root, 'src/ui', file), 'utf8');
      for (const m of html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)) {
        expect(locales.en, `${file}: ${m[1]}`).toHaveProperty(m[1]!);
      }
    }
  });

  it('every t("…") key used in the code exists', () => {
    const files = ['src/ui/popup/main.ts', 'src/ui/popup/table.ts', 'src/ui/popup/lightbox.ts', 'src/ui/settings-form.ts', 'src/ui/options/main.ts'];
    for (const file of files) {
      const code = readFileSync(resolve(root, file), 'utf8');
      for (const m of code.matchAll(/\bt\('([A-Za-z]+)'/g)) expect(locales.en, `${file}: ${m[1]}`).toHaveProperty(m[1]!);
    }
    const state = readFileSync(resolve(root, 'src/ui/popup/state.ts'), 'utf8');
    for (const m of state.matchAll(/key: '([A-Za-z]+)'/g)) expect(locales.en).toHaveProperty(m[1]!);
  });
});
