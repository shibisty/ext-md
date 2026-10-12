// blob: URLs only resolve inside the page that created them, so their bytes
// are read here and handed to the extension a few MB at a time (zip and
// chosen-folder modes). Peak memory stays bounded by the chunk size.

import { bytesToBase64 } from '../shared/base64';
import { STREAM_UNAVAILABLE } from '../shared/types';

export const STREAM_CHUNK_BYTES = 3 * 1024 * 1024;
export const STREAM_EXPIRED = 'stream-expired';
const IDLE_TIMEOUT_MS = 60_000;

type StreamEntry =
  | { kind: 'reader'; reader: ReadableStreamDefaultReader<Uint8Array>; pending: Uint8Array | null; lastUsed: number }
  | { kind: 'buffer'; buffer: ArrayBuffer; offset: number; lastUsed: number };

const streams = new Map<string, StreamEntry>();

/** Cancels streams nobody has pulled from for a while (popup closed, worker restarted…). */
function sweepIdle(now: number): void {
  for (const [id, entry] of streams) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      if (entry.kind === 'reader') entry.reader.cancel().catch(() => {});
      streams.delete(id);
    }
  }
}

export async function openBlobStream(url: string): Promise<{ id: string; mime: string }> {
  sweepIdle(Date.now());
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(STREAM_UNAVAILABLE);
  }
  const mime = response.headers.get('content-type') || '';
  const id = `strm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (response.body && typeof response.body.getReader === 'function') {
    streams.set(id, { kind: 'reader', reader: response.body.getReader(), pending: null, lastUsed: Date.now() });
  } else {
    const blob = await response.blob();
    if (!blob || blob.size === 0) throw new Error(STREAM_UNAVAILABLE);
    streams.set(id, { kind: 'buffer', buffer: await blob.arrayBuffer(), offset: 0, lastUsed: Date.now() });
  }
  return { id, mime };
}

export async function nextBlobChunk(id: string): Promise<{ done: true } | { done: false; base64: string }> {
  const entry = streams.get(id);
  // Unknown id (idle-swept, or the script was re-injected): an error, never
  // "done" — that would silently save a truncated file.
  if (!entry) throw new Error(STREAM_EXPIRED);
  entry.lastUsed = Date.now();

  if (entry.kind === 'buffer') {
    if (entry.offset >= entry.buffer.byteLength) {
      streams.delete(id);
      return { done: true };
    }
    const end = Math.min(entry.offset + STREAM_CHUNK_BYTES, entry.buffer.byteLength);
    const slice = new Uint8Array(entry.buffer, entry.offset, end - entry.offset);
    entry.offset = end;
    return { done: false, base64: bytesToBase64(slice) };
  }

  // Reader chunks can be tiny (64 KB) or huge; re-batch them to ~STREAM_CHUNK_BYTES
  // so the number of messages stays low and each message stays bounded.
  const parts: Uint8Array[] = [];
  let size = 0;
  if (entry.pending) {
    parts.push(entry.pending);
    size += entry.pending.length;
    entry.pending = null;
  }
  while (size < STREAM_CHUNK_BYTES) {
    const { done, value } = await entry.reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    const room = STREAM_CHUNK_BYTES - size;
    if (value.length > room) {
      parts.push(value.subarray(0, room));
      entry.pending = value.subarray(room);
      size += room;
      break;
    }
    parts.push(value);
    size += value.length;
  }
  if (size === 0) {
    streams.delete(id);
    return { done: true };
  }
  const chunk = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    chunk.set(p, offset);
    offset += p.length;
  }
  return { done: false, base64: bytesToBase64(chunk) };
}

export async function blobUrlToDataUrl(blobUrl: string): Promise<{ dataUrl: string; mime: string }> {
  let response: Response;
  try {
    response = await fetch(blobUrl);
  } catch {
    throw new Error(STREAM_UNAVAILABLE);
  }
  const blob = await response.blob();
  // A MediaSource-backed blob: URL (HLS/DASH via MSE) has no byte stream.
  if (!blob || blob.size === 0) throw new Error(STREAM_UNAVAILABLE);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mime: blob.type };
}

/**
 * Native <a download> click for a blob: URL — the browser streams it to disk
 * itself, so size is unlimited and the popup can close meanwhile.
 */
export async function triggerNativeDownload(url: string, filename?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Headers only, the body is never read.
    const probe = await fetch(url);
    const len = probe.headers.get('content-length');
    probe.body?.cancel().catch(() => {});
    if (len !== null && parseInt(len, 10) === 0) return { ok: false, error: STREAM_UNAVAILABLE };
  } catch {
    return { ok: false, error: STREAM_UNAVAILABLE };
  }
  try {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 2000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function activeStreamCount(): number {
  return streams.size;
}
