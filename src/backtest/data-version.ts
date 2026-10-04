/**
 * Data version of a backtest: a hash over exactly the stored bhavcopy files a run covered.
 *
 * Two hashes are kept:
 *  - raw: the exchange zips as downloaded (ground truth; never rewritten),
 *  - normalized: the parsed JSONL the engine actually reads (changes if the parser changes).
 * Each is sha256 over lines "<date> <sha256 of file>\n" in date order, so a missing, extra or
 * altered day changes the version.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DataVersion {
  from: string;
  to: string;
  days: number;
  rawSha256: string;
  normalizedSha256: string;
  /** Normalized-format version the normalized hash refers to (absent in files written before v2 = 1). */
  normalizerVersion?: number;
  /** Dates in range whose raw zip is missing (normalized-only data). Empty for a clean dataset. */
  missingRaw: string[];
}

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Normalized-format version of one JSONL file, read from its first record (v2 added instrumentId). */
export function normalizedFormatVersion(buf: Buffer): number {
  const nl = buf.indexOf(10);
  const first = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8')) as Record<string, unknown>;
  return 'instrumentId' in first ? 2 : 1;
}

export function computeDataVersion(root: string, dates: readonly string[]): DataVersion {
  const sorted = [...dates].sort();
  const raw = createHash('sha256');
  const norm = createHash('sha256');
  const missingRaw: string[] = [];
  const versions = new Map<number, string>();
  for (const d of sorted) {
    const rp = join(root, 'raw', `${d}.csv.zip`);
    if (existsSync(rp)) raw.update(`${d} ${sha(readFileSync(rp))}\n`);
    else missingRaw.push(d);
    const np = join(root, 'normalized', `${d}.jsonl`);
    if (!existsSync(np)) throw new Error(`Data version: normalized file missing for ${d}`);
    const nb = readFileSync(np);
    const v = normalizedFormatVersion(nb);
    if (!versions.has(v)) versions.set(v, d);
    norm.update(`${d} ${sha(nb)}\n`);
  }
  if (versions.size > 1) {
    throw new Error(`Normalized store mixes formats (${[...versions].map(([v, d]) => `v${v} e.g. ${d}`).join(', ')}). Re-normalize with the bhavcopy CLI.`);
  }
  return {
    from: sorted[0] ?? '',
    to: sorted[sorted.length - 1] ?? '',
    days: sorted.length,
    rawSha256: raw.digest('hex'),
    normalizedSha256: norm.digest('hex'),
    normalizerVersion: [...versions.keys()][0] ?? 1,
    missingRaw,
  };
}
