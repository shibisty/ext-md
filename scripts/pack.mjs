// Packs store uploads after `npm run build`:
//   dist/media-grabber-<version>-chrome.zip   → Chrome Web Store
//   dist/media-grabber-<version>-firefox.zip  → addons.mozilla.org
//   dist/media-grabber-<version>-source.zip   → AMO "source code" upload
//     (required because the shipped files are produced by a bundler)
// No dependencies: a small deflate ZIP writer on top of node:zlib.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function walk(dir, filter = () => true) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!filter(full)) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else out.push(full);
  }
  return out;
}

function zip(files, base, outFile) {
  const local = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp → reproducible archives (2026-01-01 00:00).
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const file of files) {
    const name = Buffer.from(relative(base, file).split(sep).join('/'), 'utf8');
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...local, cd, end]));
  console.log(`${relative(root, outFile)}  (${files.length} files)`);
}

for (const target of ['chrome', 'firefox']) {
  const dir = join(root, 'dist', target);
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`dist/${target} is missing — run npm run build first`);
  zip(walk(dir), dir, join(root, 'dist', `media-grabber-${version}-${target}.zip`));
}

const SOURCE_ENTRIES = [
  'src', 'public', 'tests', 'scripts',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts',
  'README.md', 'ARCHITECTURE.md',
];
const sourceFiles = SOURCE_ENTRIES.map((e) => join(root, e))
  .filter(existsSync)
  .flatMap((p) => (statSync(p).isDirectory() ? walk(p) : [p]));
zip(sourceFiles, root, join(root, 'dist', `media-grabber-${version}-source.zip`));
