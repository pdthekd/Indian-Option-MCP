#!/usr/bin/env node
/**
 * Run the reference end-of-day backtest over stored NSE bhavcopy files.
 *
 *   node dist/backtest-cli.mjs [--from 2024-10-01] [--to 2026-10-01]
 *                              [--brokerage-plan ZERODHA-FO-r3] [--spread-model EOD_PESSIMISTIC_V1]
 *                              [--write-golden <file>] [--verify <golden file>]
 *
 * Writes <data dir>/backtests/<strategy>_<from>_<to>_<plan>_<spread>.{json,md} (outside the repo).
 * --verify exits 2 unless the run reproduces the golden file exactly (data version included).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../history/paths.js';
import { loadBhavcopy } from '../history/bhavcopy.js';
import { runEodBacktest, SPREAD_MODELS, EOD_PESSIMISTIC_V1 } from '../backtest/eod-engine.js';
import { buildReport, renderMarkdown } from '../backtest/report.js';
import { computeDataVersion, type DataVersion } from '../backtest/data-version.js';
import { toGolden, compareGolden, type GoldenResult } from '../backtest/golden.js';
import { DEFAULT_BROKERAGE_PLAN, brokeragePlanFor } from '../costs/transaction-cost-engine.js';
import { SUPERSEDED_BROKERAGE_PLANS } from '../config/charges/brokerage.js';
import { createRefIronCondor } from '../strategy/reference/nifty-weekly-iron-condor.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  // Charge schedules start on 2024-10-01; earlier dates would fail closed.
  const from = arg('from') ?? '2024-10-01';
  const to = arg('to') ?? '2099-12-31';
  const planId = arg('brokerage-plan') ?? DEFAULT_BROKERAGE_PLAN;
  brokeragePlanFor(planId, from); // throws on an unknown plan
  const superseded = SUPERSEDED_BROKERAGE_PLANS.find((p) => p.id === planId);
  if (superseded) console.error(`WARNING: brokerage plan ${planId} is SUPERSEDED by ${superseded.supersededBy} (reproduction only): ${superseded.reason}`);
  const spreadId = arg('spread-model') ?? EOD_PESSIMISTIC_V1.id;
  const spread = SPREAD_MODELS[spreadId];
  if (!spread) throw new Error(`Unknown spread model ${spreadId}. Known: ${Object.keys(SPREAD_MODELS).join(', ')}`);
  if (spread.id !== EOD_PESSIMISTIC_V1.id) console.error(`NOTE: spread model ${spread.id} is for sensitivity analysis only.`);

  const root = dataDir('bhavcopy/nse-fo');
  const norm = join(root, 'normalized');
  const tradeDates = readdirSync(norm).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();

  const strategy = createRefIronCondor();
  const result = runEodBacktest({
    strategy,
    tradeDates,
    load: (d) => loadBhavcopy(d) ?? [],
    from,
    to,
    spread,
    costOptions: { brokeragePlanId: planId },
  });
  const data = computeDataVersion(root, tradeDates.filter((d) => d >= result.from && d <= result.to));
  const report = buildReport(result);
  const out = dataDir('backtests');
  const base = join(out, `${strategy.id}_${result.from}_${result.to}_${planId}_${spread.id}`);
  writeFileSync(`${base}.json`, JSON.stringify({ ...report, dataVersion: data }, null, 2));
  writeFileSync(`${base}.md`, renderMarkdown(report) + `\nData version: raw \`${data.rawSha256.slice(0, 16)}\`, normalized \`${data.normalizedSha256.slice(0, 16)}\` (${data.days} days).\n`);

  const a = report.all;
  console.error(`${strategy.id} v${strategy.version} [${planId}, ${spread.id}]: ${result.from} → ${result.to}, ${result.trades.length} trades, ${result.skipped.length} skipped`);
  console.error(`GROSS ${a.grossTotal.toFixed(2)} | COSTS ${a.costsTotal.toFixed(2)} | NET ${a.netTotal.toFixed(2)} | verdict: ${a.verdict}`);
  console.error(`Development: NET ${report.development.netTotal.toFixed(2)} (${report.development.trades} trades) | Out-of-sample: NET ${report.outOfSample.netTotal.toFixed(2)} (${report.outOfSample.trades} trades)`);
  console.error(`Data version: raw ${data.rawSha256.slice(0, 16)} normalized ${data.normalizedSha256.slice(0, 16)} (${data.days} days${data.missingRaw.length ? `, ${data.missingRaw.length} without raw zip` : ''})`);
  console.error(`Report: ${base}.md`);

  const golden = toGolden(arg('label') ?? `${strategy.id} v${strategy.version} ${planId} ${spread.id}`, result, data);
  const writeTo = arg('write-golden');
  if (writeTo) {
    writeFileSync(writeTo, JSON.stringify(golden, null, 2) + '\n');
    console.error(`Golden written: ${writeTo}`);
  }
  const verify = arg('verify');
  if (verify) {
    const expected = JSON.parse(readFileSync(verify, 'utf8')) as GoldenResult;
    const notes: string[] = [];
    const diffs = compareGolden(expected, golden, notes);
    for (const n of notes) console.error(`NOTE: ${n}`);
    // A pin file next to the golden can supply the normalized hash for newer normalizer versions.
    const pinFile = join(dirname(verify), 'data-versions.json');
    if (existsSync(pinFile)) {
      const pins = (JSON.parse(readFileSync(pinFile, 'utf8')) as { pins: Array<DataVersion & { normalizerVersion: number }> }).pins;
      const pin = pins.find((p) => p.from === data.from && p.to === data.to && p.normalizerVersion === (data.normalizerVersion ?? 1));
      if (!pin) diffs.push(`no pinned data version for ${data.from} → ${data.to}, normalizer v${data.normalizerVersion ?? 1} in ${pinFile}`);
      else {
        if (pin.rawSha256 !== data.rawSha256) diffs.push(`pinned raw hash differs: ${pin.rawSha256} vs ${data.rawSha256}`);
        if (pin.normalizedSha256 !== data.normalizedSha256) diffs.push(`pinned normalized hash (v${pin.normalizerVersion}) differs: ${pin.normalizedSha256} vs ${data.normalizedSha256}`);
        else console.error(`Normalized data matches pinned v${pin.normalizerVersion} hash.`);
      }
    }
    if (diffs.length) {
      console.error(`VERIFY FAILED against ${verify}: ${diffs.length} difference(s)`);
      for (const d of diffs.slice(0, 40)) console.error(`  ${d}`);
      return 2;
    }
    console.error(`VERIFY OK: reproduces ${verify} exactly (${golden.trades} trades, net ${golden.netTotal.toFixed(2)}).`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
