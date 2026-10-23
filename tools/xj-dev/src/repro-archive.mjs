import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { CliError } from './envelope.mjs';

export const REPRO_FORMAT = 'xj-repro/1';
export const ARCHIVE_LIMITS = Object.freeze({ files: 10000, entry: 64 * 1024 * 1024, total: 256 * 1024 * 1024, zip: 128 * 1024 * 1024 });
export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function reproError(code, message) {
  return new CliError('repro', code, message, { recovery: '检查复现包、采集范围与本机工具版本；修复后重试，已有环境保持原样。' });
}

export function safeEntry(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || /[\\:\x00-\x1f\x7f]/.test(name)
    || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw reproError('UNSAFE_PATH', '包内路径不适用于安全的跨平台解包。');
  }
  return name;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A bounded ZIP subset: UTF-8 regular files, DEFLATE, no encryption/descriptors/ZIP64/links.
// Fixed timestamps make retries and content-addressed storage independent of filesystem mtimes.
export function encodeZip(entries) {
  const local = [], central = [];
  let offset = 0, total = 0;
  if (!entries.size || entries.size > ARCHIVE_LIMITS.files) throw reproError('PACKAGE_LIMIT', '包文件数超出限制。');
  const names = new Set();
  for (const [name, input] of [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    safeEntry(name);
    if (names.has(name.normalize('NFC').toLowerCase())) throw reproError('UNSAFE_PATH', '包内存在大小写或 Unicode 规范化冲突。');
    names.add(name.normalize('NFC').toLowerCase());
    const data = Buffer.from(input), filename = Buffer.from(name), compressed = deflateRawSync(data);
    total += data.length;
    if (data.length > ARCHIVE_LIMITS.entry || total > ARCHIVE_LIMITS.total) throw reproError('PACKAGE_LIMIT', '包内容超出限制。');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, index, end]);
  if (zip.length > ARCHIVE_LIMITS.zip) throw reproError('PACKAGE_LIMIT', 'ZIP 超出大小限制。');
  return zip;
}

export function decodeZip(zip) {
  const invalid = () => { throw reproError('INVALID_ZIP', 'ZIP 边界、类型、校验或压缩格式无效。'); };
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > ARCHIVE_LIMITS.zip) invalid();
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)
    || zip.readUInt16LE(end + 20)) invalid();
  const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16);
  if (!count || count > ARCHIVE_LIMITS.files || zip.readUInt16LE(end + 8) !== count
    || start + zip.readUInt32LE(end + 12) !== end) invalid();
  let position = start, nextLocal = 0, total = 0;
  const entries = new Map(), names = new Set();
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || zip.readUInt32LE(position) !== 0x02014b50) invalid();
    const flags = zip.readUInt16LE(position + 8), method = zip.readUInt16LE(position + 10);
    const crc = zip.readUInt32LE(position + 16), compressed = zip.readUInt32LE(position + 20), size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28), extra = zip.readUInt16LE(position + 30), comment = zip.readUInt16LE(position + 32);
    const attributes = zip.readUInt32LE(position + 38), offset = zip.readUInt32LE(position + 42);
    if (flags !== 0x800 || method !== 8 || extra || comment || zip.readUInt16LE(position + 34)
      || (attributes >>> 16 & 0o170000) !== 0o100000 || position + 46 + nameLength > end || offset !== nextLocal
      || size > ARCHIVE_LIMITS.entry || (total += size) > ARCHIVE_LIMITS.total) invalid();
    const rawName = zip.subarray(position + 46, position + 46 + nameLength), name = rawName.toString('utf8');
    if (!Buffer.from(name).equals(rawName)) invalid();
    safeEntry(name);
    if (names.has(name.normalize('NFC').toLowerCase())) throw reproError('UNSAFE_PATH', 'ZIP 包含重复或大小写/Unicode 冲突的文件。');
    names.add(name.normalize('NFC').toLowerCase());
    if (offset + 30 > start || zip.readUInt32LE(offset) !== 0x04034b50
      || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method
      || zip.readUInt32LE(offset + 14) !== crc || zip.readUInt32LE(offset + 18) !== compressed
      || zip.readUInt32LE(offset + 22) !== size || zip.readUInt16LE(offset + 26) !== nameLength || zip.readUInt16LE(offset + 28)) invalid();
    const dataStart = offset + 30 + nameLength;
    nextLocal = dataStart + compressed;
    if (nextLocal > start || !zip.subarray(offset + 30, dataStart).equals(rawName)) invalid();
    let data;
    try { data = inflateRawSync(zip.subarray(dataStart, nextLocal), { maxOutputLength: Math.max(size, 1) }); } catch { invalid(); }
    if (data.length !== size || crc32(data) !== crc) invalid();
    entries.set(name, data);
    position += 46 + nameLength;
  }
  if (position !== end || nextLocal !== start) invalid();
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); if (names.has(parts.join('/'))) throw reproError('UNSAFE_PATH', 'ZIP 文件和目录冲突。'); }
  }
  return entries;
}
