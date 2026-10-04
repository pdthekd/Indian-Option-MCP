#!/usr/bin/env node
/**
 * Run the reference end-of-day backtest over stored NSE bhavcopy files.
 *
 *   node dist/backtest-cli.mjs [--from 2024-10-01] [--to 2026-10-01]
 *
 * Writes <data dir>/backtests/<strategy>_<from>_<to>.{json,md} (outside the repo).
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../history/paths.js';
import { loadBhavcopy } from '../history/bhavcopy.js';
import { runEodBacktest, EOD_PESSIMISTIC_V1 } from '../backtest/eod-engine.js';
import { buildReport, renderMarkdown } from '../backtest/report.js';
import { createRefIronCondor } from '../strategy/reference/nifty-weekly-iron-condor.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  // Charge schedules start on 2024-10-01; earlier dates would fail closed.
  const from = arg('from') ?? '2024-10-01';
  const to = arg('to') ?? '2099-12-31';
  const norm = join(dataDir('bhavcopy/nse-fo'), 'normalized');
  const tradeDates = readdirSync(norm).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();

  const strategy = createRefIronCondor();
  const result = runEodBacktest({
    strategy,
    tradeDates,
    load: (d) => loadBhavcopy(d) ?? [],
    from,
    to,
    spread: EOD_PESSIMISTIC_V1,
  });
  const report = buildReport(result);
  const out = dataDir('backtests');
  const base = join(out, `${strategy.id}_${result.from}_${result.to}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${base}.md`, renderMarkdown(report));

  const a = report.all;
  console.error(`${strategy.id} v${strategy.version}: ${result.from} → ${result.to}, ${result.trades.length} trades, ${result.skipped.length} skipped`);
  console.error(`GROSS ${a.grossTotal.toFixed(2)} | COSTS ${a.costsTotal.toFixed(2)} | NET ${a.netTotal.toFixed(2)} | verdict: ${a.verdict}`);
  console.error(`Development: NET ${report.development.netTotal.toFixed(2)} (${report.development.trades} trades) | Out-of-sample: NET ${report.outOfSample.netTotal.toFixed(2)} (${report.outOfSample.trades} trades)`);
  console.error(`Report: ${base}.md`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
