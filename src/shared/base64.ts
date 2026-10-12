// Base64 helpers for shipping bytes through extension messaging (JSON only).
// Uses the native Uint8Array.prototype.toBase64 / Uint8Array.fromBase64
// (Chrome 140+, Firefox 133+) when present; otherwise a chunked fallback —
// String.fromCharCode.apply on a whole multi-MB array would exceed the
// argument-count limit, so it goes in 32 KB slices.

type NativeBase64 = {
  toBase64?: (this: Uint8Array) => string;
};
type NativeBase64Ctor = {
  fromBase64?: (s: string) => Uint8Array;
};

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as NativeBase64).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as NativeBase64Ctor).fromBase64;
  if (typeof native === 'function') return native(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
