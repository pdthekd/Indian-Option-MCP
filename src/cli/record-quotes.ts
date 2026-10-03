#!/usr/bin/env node
/**
 * Record bid/ask snapshots from the live option chain during market hours.
 * Writes JSONL files under <data dir>/quotes/nse-fo (outside the repo).
 *
 *   node dist/record-quotes-cli.mjs [--symbols NIFTY,BANKNIFTY] [--interval 60] [--strikes 10] [--once]
 *
 * Read-only: uses the same data provider as the MCP server; places no orders.
 */

import { createDataProvider } from '../data/provider-factory.js';
import { QuoteRecorder } from '../history/quote-recorder.js';
import { isMarketOpen } from '../utils/date.js';
import { dataRoot } from '../history/paths.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const symbols = (arg('symbols') ?? 'NIFTY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const intervalS = Number(arg('interval') ?? 60);
  const strikes = Number(arg('strikes') ?? 10);
  const once = process.argv.includes('--once');
  if (!Number.isInteger(intervalS) || intervalS < 30 || intervalS > 3600) throw new Error('--interval must be 30–3600 seconds');
  if (!Number.isInteger(strikes) || strikes < 1 || strikes > 30) throw new Error('--strikes must be 1–30');

  const recorder = new QuoteRecorder({
    provider: createDataProvider(),
    symbols,
    strikesEachSide: strikes,
    marketOpen: isMarketOpen,
  });
  console.error(`Recording ${symbols.join(', ')} every ${intervalS}s, ATM±${strikes}, to ${dataRoot()}/quotes/nse-fo`);

  let stop = false;
  process.on('SIGINT', () => { stop = true; console.error('Stopping after current cycle…'); });

  let lastClosedLog = 0;
  do {
    const started = Date.now();
    const r = await recorder.cycle();
    const closed = r.skipped.some((s) => s.symbol === '*');
    if (closed) {
      if (Date.now() - lastClosedLog > 30 * 60_000) { console.error(`${r.at}  market closed — idle`); lastClosedLog = Date.now(); }
    } else {
      console.error(`${r.at}  wrote ${r.written} rows${r.skipped.length ? `; skipped: ${r.skipped.map((s) => `${s.symbol}${s.expiry ? ' ' + s.expiry : ''} (${s.reason})`).join('; ')}` : ''}`);
    }
    if (once || stop) break;
    const wait = Math.max(1000, intervalS * 1000 - (Date.now() - started));
    await new Promise((res) => setTimeout(res, wait));
  } while (!stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
