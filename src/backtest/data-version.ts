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
  /** Dates in range whose raw zip is missing (normalized-only data). Empty for a clean dataset. */
  missingRaw: string[];
}

const fileHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

export function computeDataVersion(root: string, dates: readonly string[]): DataVersion {
  const sorted = [...dates].sort();
  const raw = createHash('sha256');
  const norm = createHash('sha256');
  const missingRaw: string[] = [];
  for (const d of sorted) {
    const rp = join(root, 'raw', `${d}.csv.zip`);
    if (existsSync(rp)) raw.update(`${d} ${fileHash(rp)}\n`);
    else missingRaw.push(d);
    const np = join(root, 'normalized', `${d}.jsonl`);
    if (!existsSync(np)) throw new Error(`Data version: normalized file missing for ${d}`);
    norm.update(`${d} ${fileHash(np)}\n`);
  }
  return {
    from: sorted[0] ?? '',
    to: sorted[sorted.length - 1] ?? '',
    days: sorted.length,
    rawSha256: raw.digest('hex'),
    normalizedSha256: norm.digest('hex'),
    missingRaw,
  };
}
