import type { ThemeSetting } from '../shared/types';

let mediaQuery: MediaQueryList | null = null;
let current: ThemeSetting = 'system';

export function resolveTheme(theme: ThemeSetting, prefersLight: boolean): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersLight ? 'light' : 'dark';
}

function prefersLight(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

/** Applies the theme and, for "system", follows OS changes live. */
export function applyTheme(theme: ThemeSetting): 'light' | 'dark' {
  current = theme;
  if (!mediaQuery && window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    mediaQuery.addEventListener?.('change', () => {
      if (current === 'system') document.documentElement.setAttribute('data-theme', resolveTheme('system', prefersLight()));
    });
  }
  const resolved = resolveTheme(theme, prefersLight());
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}

export function currentResolvedTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
