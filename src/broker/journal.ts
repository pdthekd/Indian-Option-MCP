/**
 * @module broker/journal
 * Append-only, hash-chained event journal. Entries cannot be modified or
 * removed through this API, and any tampering with a persisted file is
 * detected by verify().
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { redactObject } from '../utils/redact.js';

export interface JournalEntry {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function digest(e: Omit<JournalEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify([e.seq, e.ts, e.type, e.payload, e.prevHash])).digest('hex');
}

export class Journal {
  private readonly entries: JournalEntry[] = [];

  /**
   * @param filePath Optional JSONL sink. Opened in append mode only; the
   *   journal never rewrites or truncates it.
   */
  constructor(private readonly filePath?: string, private readonly clock: () => Date = () => new Date()) {
    if (filePath && existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (line.trim()) this.entries.push(Object.freeze(JSON.parse(line)) as JournalEntry);
      }
      const v = Journal.verifyEntries(this.entries);
      if (!v.ok) throw new Error(`Journal ${filePath} failed verification at seq ${v.badSeq}: refusing to continue.`);
    }
  }

  append(type: string, payload: unknown): JournalEntry {
    const prev = this.entries[this.entries.length - 1];
    const base = {
      seq: (prev?.seq ?? 0) + 1,
      ts: this.clock().toISOString(),
      type,
      // Payloads are redacted and deep-copied so later mutation of the caller's
      // objects cannot change history.
      payload: JSON.parse(JSON.stringify(redactObject(payload))),
      prevHash: prev?.hash ?? GENESIS,
    };
    const entry = Object.freeze({ ...base, hash: digest(base) });
    this.entries.push(entry);
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
    return entry;
  }

  all(): readonly JournalEntry[] {
    return this.entries.slice();
  }

  ofType(type: string): JournalEntry[] {
    return this.entries.filter((e) => e.type === type);
  }

  verify(): { ok: boolean; badSeq?: number } {
    return Journal.verifyEntries(this.entries);
  }

  static verifyEntries(entries: readonly JournalEntry[]): { ok: boolean; badSeq?: number } {
    let prev = GENESIS;
    for (const e of entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || digest(rest) !== hash) return { ok: false, badSeq: e.seq };
      prev = hash;
    }
    return { ok: true };
  }
}
