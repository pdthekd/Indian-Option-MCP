import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCycle, writeStatus, readStatus, type RecorderStatus } from '../history/recorder-status.js';

const base: RecorderStatus = {
  state: 'STARTING', pid: 1, startedAt: '2026-10-05T03:40:00.000Z', updatedAt: '2026-10-05T03:40:00.000Z', istDate: '2026-10-05',
  symbols: ['NIFTY'], intervalSeconds: 60, stopAtIst: '15:35', cycles: 0, rowsToday: 0, lastWriteAt: null,
  consecutiveEmptyCycles: 0, lastSkipReasons: [], lastError: null,
};

describe('recorder status', () => {
  it('counts rows, tracks last write and empty cycles', () => {
    let s = applyCycle(base, { at: '2026-10-05T03:46:00.000Z', written: 40, skipped: [] }, '2026-10-05');
    expect(s).toMatchObject({ state: 'RECORDING', cycles: 1, rowsToday: 40, lastWriteAt: '2026-10-05T03:46:00.000Z', consecutiveEmptyCycles: 0 });
    s = applyCycle(s, { at: '2026-10-05T03:47:00.000Z', written: 0, skipped: [{ symbol: 'NIFTY', reason: 'fetch failed: HTTP 403' }] }, '2026-10-05');
    expect(s.consecutiveEmptyCycles).toBe(1);
    expect(s.lastWriteAt).toBe('2026-10-05T03:46:00.000Z');
    expect(s.lastSkipReasons[0]).toMatch(/HTTP 403/);
  });
  it('reports market closed as idle, not as a failure', () => {
    const s = applyCycle(base, { at: '2026-10-04T05:00:00.000Z', written: 0, skipped: [{ symbol: '*', reason: 'market closed' }] }, '2026-10-04');
    expect(s.state).toBe('IDLE_MARKET_CLOSED');
    expect(s.consecutiveEmptyCycles).toBe(0);
  });
  it('resets daily counters on a new IST date', () => {
    const y = { ...base, rowsToday: 500, lastWriteAt: '2026-10-05T09:59:00.000Z' };
    const s = applyCycle(y, { at: '2026-10-06T03:46:00.000Z', written: 0, skipped: [] }, '2026-10-06');
    expect(s.rowsToday).toBe(0);
    expect(s.lastWriteAt).toBeNull();
  });
  it('writes and reads the file atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohq-status-'));
    writeStatus(dir, base);
    expect(readStatus(dir)).toEqual(base);
  });
});

describe('closing-window coverage (15:00–15:29 IST)', async () => {
  const { closingWindowCoverage } = await import('../history/closing-window.js');
  const row = (utc: string, symbol: string, bid: number | null = 10, ask: number | null = 10.5) => ({
    recordedAt: utc, sourceAsOf: null, quality: 'FULL', source: 'x', symbol, expiry: '2026-10-06', spot: 1, strike: 1,
    type: 'CE' as const, bid, ask, bidQty: 1, askQty: 1, ltp: null, iv: null, oi: null, volume: null,
  });
  it('counts minutes with data for every symbol, per symbol, two-sided quotes, and rates the session', () => {
    const rows = [];
    // NIFTY every minute 15:00–15:29 IST (09:30–09:59 UTC); BANKNIFTY only 15:00–15:14; one row outside the window.
    for (let m = 0; m < 30; m++) rows.push(row(`2026-10-05T09:${String(30 + m).padStart(2, '0')}:10Z`, 'NIFTY'));
    for (let m = 0; m < 15; m++) rows.push(row(`2026-10-05T09:${String(30 + m).padStart(2, '0')}:20Z`, 'BANKNIFTY', null, 5));
    rows.push(row('2026-10-05T10:01:00Z', 'NIFTY')); // 15:31 IST
    const [c] = closingWindowCoverage(rows);
    expect(c.date).toBe('2026-10-05');
    expect(c.minutesCoveredBySymbol).toEqual({ BANKNIFTY: 15, NIFTY: 30 });
    expect(c.minutesCoveredAllSymbols).toBe(15);
    expect(c.twoSidedQuotes).toBe(30);           // BANKNIFTY rows have no bid
    expect(c.rating).toBe('PARTIAL');           // worst symbol 15 of 30
    expect(c.missingMinutes[0]).toBe('15:15');
  });
  it('rates NONE when nothing was recorded in the window', () => {
    expect(closingWindowCoverage([row('2026-10-05T04:00:00Z', 'NIFTY')])[0].rating).toBe('NONE');
  });
});
