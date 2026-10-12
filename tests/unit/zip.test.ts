import { describe, expect, it } from 'vitest';
import { crc32, createZip, dosDateTime } from '../../src/shared/zip';

/** Minimal reader: walks the central directory and returns entries with their data. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let p = view.getUint32(eocd + 16, true);
  expect(p + cdSize).toBe(eocd);
  const decoder = new TextDecoder();
  const entries: { name: string; data: Uint8Array; crc: number; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const flags = view.getUint16(p + 8, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLen;
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + size), crc, flags });
    p += 46 + nameLen;
  }
  return entries;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('createZip', () => {
  it('round-trips names (incl. UTF-8) and bytes', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new TextEncoder().encode('привіт, світ');
    const zip = createZip([
      { name: '01_photo.jpg', data: a },
      { name: '02_кіт.png', data: b },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['01_photo.jpg', '02_кіт.png']);
    expect([...entries[0]!.data]).toEqual([...a]);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe('привіт, світ');
    expect(entries[1]!.crc).toBe(crc32(b));
    expect(entries.every((e) => e.flags & 0x0800)).toBe(true);
  });

  it('writes a valid empty archive', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('refuses more entries than classic ZIP allows', () => {
    const files = Array.from({ length: 0x10000 }, (_, i) => ({ name: String(i), data: new Uint8Array() }));
    expect(() => createZip(files)).toThrow('zip-too-many-files');
  });
});

describe('dosDateTime', () => {
  it('encodes date and 2-second time resolution', () => {
    const { time, date } = dosDateTime(new Date(2026, 9, 12, 8, 30, 59));
    expect(time >> 11).toBe(8);
    expect((time >> 5) & 0x3f).toBe(30);
    expect(time & 0x1f).toBe(29);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0xf).toBe(10);
    expect(date & 0x1f).toBe(12);
  });

  it('clamps years before 1980', () => {
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe('base64 helpers', async () => {
  const { bytesToBase64, base64ToBytes, concatBytes } = await import('../../src/shared/base64');
  it('round-trips more than one 32 KB slice', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64ToBytes(b64)).toEqual(bytes);
  });
  it('concatBytes', () => {
    expect([...concatBytes([new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3])])]).toEqual([1, 2, 3]);
  });
});
