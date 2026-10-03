/**
 * @module history/zip
 * Minimal, dependency-free reader for ZIP archives (stored or deflate
 * entries), sufficient for NSE bhavcopy files. Uses the central directory,
 * so sizes are always known.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** Refuse to inflate anything larger than this (zip-bomb guard). */
const MAX_UNCOMPRESSED = 512 * 1024 * 1024;

export function readZip(buf: Buffer): ZipEntry[] {
  // Find End Of Central Directory (last 64 KiB + 22 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (size > MAX_UNCOMPRESSED) throw new Error(`ZIP entry ${name} too large (${size} bytes)`);
    if (buf.readUInt32LE(localOff) !== LOC_SIG) throw new Error(`Corrupt local header for ${name}`);
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_UNCOMPRESSED });
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    if (data.length !== size) throw new Error(`Size mismatch for ${name}`);
    out.push({ name, data });
  }
  return out;
}
