#!/usr/bin/env node
/**
 * Download NSE F&O bhavcopy files for a date range into the local data
 * directory (outside the repo) and cross-check lot sizes.
 *
 *   node dist/bhavcopy-cli.mjs --from 2025-05-01 --to 2025-05-31 [--symbols NIFTY,BANKNIFTY]
 */

import { fetchBhavcopy, loadBhavcopy, checkLotSizes, DEFAULT_SYMBOLS, UDIFF_START } from '../history/bhavcopy.js';
import { isNseTradingHoliday, holidayDataStatus } from '../data/constants/holidays.js';
import { dataRoot } from '../history/paths.js';

const MAX_DAYS = 400;
const GAP_MS = 1500; // be polite to NSE's archive server

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function* dates(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function main(): Promise<void> {
  const from = arg('from');
  const to = arg('to') ?? from;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !to || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    console.error('Usage: --from YYYY-MM-DD [--to YYYY-MM-DD] [--symbols NIFTY,BANKNIFTY]');
    process.exit(2);
  }
  if (from < UDIFF_START) {
    console.error(`Only dates from ${UDIFF_START} (UDiFF format) are supported.`);
    process.exit(2);
  }
  const all = [...dates(from, to)];
  if (all.length > MAX_DAYS) {
    console.error(`Range too large (${all.length} days; max ${MAX_DAYS} per run).`);
    process.exit(2);
  }
  const symbols = (arg('symbols') ?? DEFAULT_SYMBOLS.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  console.error(`Data directory: ${dataRoot()}`);

  const counts = { OK: 0, NO_FILE: 0, ERROR: 0, SKIPPED: 0 };
  let first = true;
  for (const d of all) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const year = Number(d.slice(0, 4));
    if (dow === 0 || dow === 6 || (isNseTradingHoliday(d) && holidayDataStatus(year).verification === 'OFFICIAL')) {
      counts.SKIPPED++;
      continue;
    }
    if (!first) await new Promise((r) => setTimeout(r, GAP_MS));
    first = false;
    const e = await fetchBhavcopy(d, { symbols });
    counts[e.status]++;
    console.error(`${d}  ${e.status.padEnd(7)} ${e.status === 'OK' ? `${e.rows} rows, kept ${e.keptRows}` : e.detail ?? ''}`);
  }

  // Lot-size cross-check over everything downloaded in this range.
  const records = all.flatMap((d) => loadBhavcopy(d) ?? []);
  const checks = checkLotSizes(records.filter((r) => r.instrumentType === 'IDX_OPT'));
  const bad = checks.filter((c) => c.status === 'MISMATCH');
  const transition = checks.filter((c) => c.status === 'TRANSITION').length;
  console.error(`\nDownloaded: ${counts.OK} ok, ${counts.NO_FILE} no file, ${counts.ERROR} errors, ${counts.SKIPPED} weekend/holiday skipped`);
  console.error(`Lot-size check (index options, per contract per day): ${checks.length - bad.length - transition} match, ${bad.length} mismatch, ${transition} in transition windows (bhavcopy is authoritative there)`);
  for (const b of bad) {
    console.error(`  ${b.status} ${b.symbol} ${b.expiry} on ${b.tradeDate}: bhavcopy ${b.bhavcopyLotSize}, model ${b.modelLotSize ?? '—'}${b.detail ? ` (${b.detail})` : ''}`);
  }
  process.exit(counts.ERROR > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
