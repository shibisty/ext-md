import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/manifest';

describe('buildManifest', () => {
  it('chrome: service worker + side panel', () => {
    const m = buildManifest('chrome', '1.2.3');
    expect(m.version).toBe('1.2.3');
    expect(m.background).toEqual({ service_worker: 'background.js' });
    expect(m.permissions).toContain('sidePanel');
    expect(m.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(m).not.toHaveProperty('browser_specific_settings');
    expect(m).not.toHaveProperty('sidebar_action');
  });

  it('firefox: event page + sidebar_action + gecko settings, no Chrome-only keys', () => {
    const m = buildManifest('firefox', '1.2.3');
    expect(m.background).toEqual({ scripts: ['background.js'] });
    expect(m.permissions).not.toContain('sidePanel');
    expect(m).not.toHaveProperty('side_panel');
    expect(m).toHaveProperty('sidebar_action.default_panel', 'sidepanel.html');
    expect(m).toHaveProperty('browser_specific_settings.gecko.data_collection_permissions.required', ['none']);
  });

  it('does not share mutable arrays between targets', () => {
    buildManifest('chrome', '1');
    expect(buildManifest('firefox', '1').permissions).not.toContain('sidePanel');
  });
});
