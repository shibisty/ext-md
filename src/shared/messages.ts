// Typed message protocol between the popup/side panel, background and content
// script. Every request type maps to exactly one response type, so senders
// and handlers can't drift apart silently.

import type { DownloadItem, DownloadMode, DownloadResult, ScanData, Settings } from './types';

type NoPayload = {};
type Ok<T = object> = { ok: true } & T;
type Fail = { ok: false; error: string };
export type Result<T = object> = Ok<T> | Fail;

/** Messages handled by the content script (sent with chrome.tabs.sendMessage). */
export interface ContentRequests {
  MG_PING: { req: NoPayload; res: Ok };
  MG_SCAN: { req: NoPayload; res: Result<{ data: ScanData }> };
  MG_RESOLVE_BLOB: { req: { url: string }; res: Result<{ dataUrl: string; mime: string }> };
  MG_NATIVE_DOWNLOAD: { req: { url: string; filename?: string }; res: Result };
  MG_STREAM_OPEN: { req: { url: string }; res: Result<{ id: string; mime: string }> };
  MG_STREAM_NEXT: { req: { id: string }; res: Result<{ done: true } | { done: false; base64: string }> };
  MG_HIGHLIGHT: { req: { mgId?: string; url?: string }; res: Ok };
  MG_CLEAR_HIGHLIGHT: { req: NoPayload; res: Ok };
}

/** Messages handled by the background (sent with chrome.runtime.sendMessage). */
export interface BackgroundRequests {
  MG_SCAN_TAB: { req: { tabId: number }; res: Result<{ data: ScanData }> };
  MG_DOWNLOAD_ITEMS: {
    req: { tabId: number; items: DownloadItem[]; pageHost: string; saveAs?: boolean; forceMode?: DownloadMode };
    res: Result<{ results: DownloadResult[] }>;
  };
  MG_GET_SETTINGS: { req: NoPayload; res: Settings };
}

export type Message<M, K extends keyof M> = { type: K } & (M[K] extends { req: infer R } ? R : never);
export type Response<M, K extends keyof M> = M[K] extends { res: infer R } ? R : never;

export type ContentMessage = { [K in keyof ContentRequests]: Message<ContentRequests, K> }[keyof ContentRequests];
export type BackgroundMessage = { [K in keyof BackgroundRequests]: Message<BackgroundRequests, K> }[keyof BackgroundRequests];

export function sendToTab<K extends keyof ContentRequests>(
  tabId: number,
  message: Message<ContentRequests, K>,
): Promise<Response<ContentRequests, K>> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<Response<ContentRequests, K>>;
}

export function sendToBackground<K extends keyof BackgroundRequests>(
  message: Message<BackgroundRequests, K>,
): Promise<Response<BackgroundRequests, K>> {
  return chrome.runtime.sendMessage(message) as Promise<Response<BackgroundRequests, K>>;
}

export type Handlers<M> = {
  [K in keyof M]?: (msg: Message<M, K>, sender: chrome.runtime.MessageSender) => Response<M, K> | Promise<Response<M, K>>;
};

/**
 * Builds an onMessage listener from a handler map. Async handlers keep the
 * channel open (return true); thrown errors become `{ ok: false, error }`.
 * Unknown message types are ignored so several listeners can coexist.
 */
export function createRouter<M>(handlers: Handlers<M>) {
  return (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean | undefined => {
    if (!message || typeof message !== 'object' || !('type' in message)) return undefined;
    const handler = (handlers as Record<string, ((m: unknown, s: chrome.runtime.MessageSender) => unknown) | undefined>)[
      String((message as { type: unknown }).type)
    ];
    if (!handler) return undefined;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  };
}
