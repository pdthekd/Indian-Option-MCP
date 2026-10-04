/**
 * @module history/recorder-status
 * A small JSON status file the quote recorder rewrites every cycle, so
 * monitoring (scheduled checks, a human, a phone) can tell whether it is
 * alive and writing data without parsing logs.
 */

import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleResult } from './quote-recorder.js';

export type RecorderState = 'STARTING' | 'RECORDING' | 'IDLE_MARKET_CLOSED' | 'STOPPED' | 'ERROR';

export interface RecorderStatus {
  state: RecorderState;
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** IST trading date the counters refer to. */
  istDate: string;
  symbols: string[];
  intervalSeconds: number;
  stopAtIst: string | null;
  cycles: number;
  rowsToday: number;
  lastWriteAt: string | null;
  /** Consecutive cycles (market open) that wrote nothing. */
  consecutiveEmptyCycles: number;
  lastSkipReasons: string[];
  lastError: string | null;
}

export function statusPath(dir: string): string {
  return join(dir, 'status.json');
}

/** Write atomically (temp file + rename) so readers never see half a file. */
export function writeStatus(dir: string, s: RecorderStatus): void {
  const p = statusPath(dir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

export function readStatus(dir: string): RecorderStatus | null {
  const p = statusPath(dir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as RecorderStatus) : null;
}

/** Fold one cycle into the status (pure). */
export function applyCycle(prev: RecorderStatus, r: CycleResult, istDate: string): RecorderStatus {
  const newDay = prev.istDate !== istDate;
  const closed = r.skipped.some((s) => s.symbol === '*');
  const reasons = r.skipped.filter((s) => s.symbol !== '*').map((s) => `${s.symbol}${s.expiry ? ' ' + s.expiry : ''}: ${s.reason}`);
  return {
    ...prev,
    state: closed ? 'IDLE_MARKET_CLOSED' : 'RECORDING',
    updatedAt: r.at,
    istDate,
    cycles: prev.cycles + 1,
    rowsToday: (newDay ? 0 : prev.rowsToday) + r.written,
    lastWriteAt: r.written > 0 ? r.at : newDay ? null : prev.lastWriteAt,
    consecutiveEmptyCycles: closed ? 0 : r.written > 0 ? 0 : prev.consecutiveEmptyCycles + 1,
    lastSkipReasons: reasons.slice(0, 10),
    lastError: null,
  };
}
