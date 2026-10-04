#!/usr/bin/env node
/**
 * Record bid/ask snapshots from the live option chain during market hours.
 * Writes JSONL files and a status.json under <data dir>/quotes/nse-fo
 * (outside the repo).
 *
 *   node dist/record-quotes-cli.mjs [--symbols NIFTY,BANKNIFTY] [--interval 60]
 *                                   [--strikes 10] [--until 15:35] [--max-hours 7] [--once]
 *
 * --until HH:MM  stop at this IST time (e.g. after the close).
 * Read-only: uses the same data provider as the MCP server; places no orders.
 */

import { createDataProvider } from '../data/provider-factory.js';
import { QuoteRecorder } from '../history/quote-recorder.js';
import { applyCycle, writeStatus, readStatus, type RecorderStatus } from '../history/recorder-status.js';
import { isMarketOpen } from '../utils/date.js';
import { dataDir } from '../history/paths.js';
import { istDate } from '../utils/time.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Minutes since IST midnight for an instant. */
function istMinutes(d: Date): number {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

async function main(): Promise<void> {
  const symbols = (arg('symbols') ?? 'NIFTY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const intervalS = Number(arg('interval') ?? 60);
  const strikes = Number(arg('strikes') ?? 10);
  const until = arg('until') ?? null;
  const once = process.argv.includes('--once');
  if (!Number.isInteger(intervalS) || intervalS < 30 || intervalS > 3600) throw new Error('--interval must be 30–3600 seconds');
  if (!Number.isInteger(strikes) || strikes < 1 || strikes > 30) throw new Error('--strikes must be 1–30');
  let stopMinute: number | null = null;
  if (until !== null) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('--until must be HH:MM (IST)');
    stopMinute = Number(m[1]) * 60 + Number(m[2]);
  }

  const maxHours = Number(arg('max-hours') ?? 7);
  if (!(maxHours > 0 && maxHours <= 24)) throw new Error('--max-hours must be in (0, 24]');
  const deadline = Date.now() + maxHours * 3600_000;

  const dir = dataDir('quotes/nse-fo');

  // Single instance: refuse to start if another recorder is alive and updating its status.
  const prev = readStatus(dir);
  if (prev && prev.pid !== process.pid && !['STOPPED', 'ERROR'].includes(prev.state)) {
    let alive = false;
    try { process.kill(prev.pid, 0); alive = true; } catch { alive = false; }
    const fresh = Date.now() - Date.parse(prev.updatedAt) < (prev.intervalSeconds * 3 + 60) * 1000;
    if (alive && fresh) {
      console.error(`Another recorder (pid ${prev.pid}) is already running; exiting.`);
      return;
    }
  }

  const startedAt = new Date().toISOString();
  let status: RecorderStatus = {
    state: 'STARTING', pid: process.pid, startedAt, updatedAt: startedAt, istDate: istDate(), symbols,
    intervalSeconds: intervalS, stopAtIst: until, cycles: 0, rowsToday: 0, lastWriteAt: null,
    consecutiveEmptyCycles: 0, lastSkipReasons: [], lastError: null,
  };
  writeStatus(dir, status);

  const recorder = new QuoteRecorder({ provider: createDataProvider(), symbols, strikesEachSide: strikes, marketOpen: isMarketOpen });
  console.error(`Recording ${symbols.join(', ')} every ${intervalS}s, ATM±${strikes}${until ? `, until ${until} IST` : ''}, to ${dir}`);

  let stop = false;
  const finish = (state: 'STOPPED' | 'ERROR', err?: unknown) => {
    status = { ...status, state, updatedAt: new Date().toISOString(), lastError: err ? (err instanceof Error ? err.message : String(err)) : status.lastError };
    writeStatus(dir, status);
  };
  process.on('SIGINT', () => { stop = true; console.error('Stopping after current cycle…'); });

  try {
    let lastClosedLog = 0;
    do {
      if (stopMinute !== null && istMinutes(new Date()) >= stopMinute) {
        console.error(`Reached --until ${until} IST; stopping.`);
        break;
      }
      if (Date.now() >= deadline) {
        console.error(`Reached --max-hours ${maxHours}; stopping.`);
        break;
      }
      const started = Date.now();
      const r = await recorder.cycle();
      status = applyCycle(status, r, istDate(new Date(r.at)));
      writeStatus(dir, status);
      if (status.state === 'IDLE_MARKET_CLOSED') {
        if (Date.now() - lastClosedLog > 30 * 60_000) { console.error(`${r.at}  market closed — idle`); lastClosedLog = Date.now(); }
      } else {
        console.error(`${r.at}  wrote ${r.written} rows (today ${status.rowsToday})${r.skipped.length ? `; skipped: ${status.lastSkipReasons.join('; ')}` : ''}`);
      }
      if (once || stop) break;
      const wait = Math.max(1000, intervalS * 1000 - (Date.now() - started));
      await new Promise((res) => setTimeout(res, wait));
    } while (!stop);
    finish('STOPPED');
  } catch (err) {
    finish('ERROR', err);
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
