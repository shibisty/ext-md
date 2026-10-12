// Single source of truth for manifest.json. Chrome and Firefox differ in how
// the background runs (service worker vs event page), in the side panel API
// (sidePanel vs sidebar_action) and in gecko-specific settings.

export type Target = 'chrome' | 'firefox';

const ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
} as const;

export function buildManifest(target: Target, version: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: 3,
    name: '__MSG_appName__',
    version,
    description: '__MSG_appDesc__',
    default_locale: 'ru',
    permissions: ['activeTab', 'scripting', 'downloads', 'storage'],
    host_permissions: ['<all_urls>'],
    action: {
      default_popup: 'popup.html',
      default_title: 'Media Grabber',
      default_icon: ICONS,
    },
    icons: ICONS,
    options_ui: { page: 'options.html', open_in_tab: true },
    commands: {
      'download-all': {
        suggested_key: { default: 'Ctrl+Shift+M', mac: 'Command+Shift+M' },
        description: '__MSG_commandDownloadAllDesc__',
      },
    },
  };

  if (target === 'chrome') {
    (base.permissions as string[]).push('sidePanel');
    base.background = { service_worker: 'background.js' };
    base.side_panel = { default_path: 'sidepanel.html' };
    base.minimum_chrome_version = '116';
    return base;
  }

  base.background = { scripts: ['background.js'] };
  base.sidebar_action = {
    default_panel: 'sidepanel.html',
    default_title: 'Media Grabber',
    default_icon: ICONS,
    open_at_install: false,
  };
  base.browser_specific_settings = {
    gecko: {
      id: 'media-grabber@example.local',
      strict_min_version: '115.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return base;
}
