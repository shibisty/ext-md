// In-memory fake of the chrome.* APIs used by the extension. Each test gets a
// fresh instance (beforeEach), and can override any function with vi.fn().

import { beforeEach, vi } from 'vitest';

function createStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    _data: () => data,
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(items) };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
    clear: vi.fn(async () => {
      data = {};
    }),
  };
}

function createEvent() {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  return {
    listeners,
    addListener: vi.fn((fn: (...args: unknown[]) => unknown) => listeners.push(fn)),
    removeListener: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }),
    dispatch: (...args: unknown[]) => listeners.forEach((l) => l(...args)),
  };
}

export function createChromeMock() {
  return {
    storage: { local: createStorageArea(), session: createStorageArea() },
    i18n: {
      getMessage: vi.fn((key: string) => `msg:${key}`),
      getUILanguage: vi.fn(() => 'en'),
    },
    runtime: {
      id: 'test-extension',
      getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
      sendMessage: vi.fn(),
      onMessage: createEvent(),
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(),
      create: vi.fn(),
      sendMessage: vi.fn(),
      onActivated: createEvent(),
      onUpdated: createEvent(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    downloads: {
      download: vi.fn(async () => 1),
      onChanged: createEvent(),
    },
    commands: { getAll: vi.fn(async () => []), onCommand: createEvent() },
    action: { openPopup: vi.fn() },
  };
}

export type ChromeMock = ReturnType<typeof createChromeMock>;

declare global {
  // eslint-disable-next-line no-var
  var chromeMock: ChromeMock;
}

beforeEach(() => {
  const mock = createChromeMock();
  globalThis.chromeMock = mock;
  (globalThis as unknown as { chrome: unknown }).chrome = mock;
});
