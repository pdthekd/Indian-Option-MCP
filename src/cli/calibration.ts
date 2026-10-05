#!/usr/bin/env node
/**
 * Execution-calibration report from recorded quotes (read-only).
 *
 *   node dist/calibration-cli.mjs
 *
 * 1. Readiness under the pre-registered calibration rule (src/analytics/spread-calibration.ts).
 * 2. Close-vs-quote gap for each recorded session whose bhavcopy is stored
 *    (src/analytics/close-gap.ts): ask − close and close − bid vs the EOD_PESSIMISTIC_V1 half-spread.
 * Writes <data dir>/calibration/calibration-report.{json,md}. Changes no model.
 * Download the day's bhavcopy first (node dist/bhavcopy-cli.mjs --from <date> --to <date>).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../history/paths.js';
import { loadBhavcopy, type BhavRecord } from '../history/bhavcopy.js';
import type { QuoteSnapshotRow } from '../history/quote-recorder.js';
import { calibrate, CALIBRATION_RULE } from '../analytics/spread-calibration.js';
import { closeGapObservations, summarizeGaps, CLOSE_WINDOW_IST } from '../analytics/close-gap.js';
import { closingWindowCoverage } from '../history/closing-window.js';

const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10);

function main(): void {
  const qdir = dataDir('quotes/nse-fo');
  const files = existsSync(qdir) ? readdirSync(qdir).filter((f) => /^\d{4}-\d{2}-\d{2}_.+\.jsonl$/.test(f)).sort() : [];
  const quotes: QuoteSnapshotRow[] = [];
  for (const f of files) for (const l of readFileSync(join(qdir, f), 'utf8').split('\n')) if (l.trim()) quotes.push(JSON.parse(l) as QuoteSnapshotRow);
  const sessions = [...new Set(quotes.map((x) => istDay(x.recordedAt)))].sort();

  // Session facts from the stored bhavcopy: expiry day? NIFTY move ≥ 1 % vs the previous stored day?
  const norm = join(dataDir('bhavcopy/nse-fo'), 'normalized');
  const stored = existsSync(norm) ? readdirSync(norm).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort() : [];
  const nifty = (d: string) => (loadBhavcopy(d) ?? []).filter((r) => r.symbol === 'NIFTY' && r.instrumentType === 'IDX_OPT');
  let expiryDays = 0, bigMoves = 0;
  const bhav: BhavRecord[] = [];
  const missingBhav: string[] = [];
  for (const d of sessions) {
    const rows = loadBhavcopy(d);
    if (!rows) { missingBhav.push(d); continue; }
    bhav.push(...rows);
    const n = rows.filter((r) => r.symbol === 'NIFTY' && r.instrumentType === 'IDX_OPT');
    if (n.some((r) => r.expiry === d)) expiryDays++;
    const prev = stored.filter((x) => x < d).at(-1);
    const s1 = n.find((r) => r.underlyingPrice !== null)?.underlyingPrice;
    const s0 = prev ? nifty(prev).find((r) => r.underlyingPrice !== null)?.underlyingPrice : undefined;
    if (s0 && s1 && Math.abs(s1 / s0 - 1) >= 0.01) bigMoves++;
  }

  const readiness = calibrate(quotes, { expiryDaySessions: expiryDays, bigMoveSessions: bigMoves });
  const obs = closeGapObservations(quotes, bhav);
  const gaps = summarizeGaps(obs);
  const coverage = closingWindowCoverage(quotes);
  const out = { generated: new Date().toISOString(), sessions, missingBhavcopy: missingBhav, closingWindowCoverage: coverage, readiness, closeGap: { window: CLOSE_WINDOW_IST, observations: obs.length, buckets: gaps } };
  const base = join(dataDir('calibration'), 'calibration-report');
  writeFileSync(`${base}.json`, JSON.stringify({ ...out, observations: obs }, null, 2));

  const f = (x: number | null) => (x === null ? '—' : `₹${x.toFixed(2)}`);
  const p = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
  const md: string[] = ['# Execution calibration report', '',
    `Sessions recorded: ${sessions.length} (${sessions[0] ?? '—'} → ${sessions.at(-1) ?? '—'}); quotes ${quotes.length}. Bhavcopy missing for: ${missingBhav.join(', ') || 'none'}.`, '',
    '## Closing-window coverage (15:00–15:29 IST, minutes with data for every symbol)', '',
    '| Session | Minutes covered (of 30) | By symbol | Two-sided quotes | Rating |', '|---|---:|---|---:|---|',
    ...coverage.map((c) => `| ${c.date} | ${c.minutesCoveredAllSymbols} | ${Object.entries(c.minutesCoveredBySymbol).map(([s, n]) => `${s} ${n}`).join(', ')} | ${c.twoSidedQuotes} | ${c.rating} |`),
    '', 'Rating: GOOD ≥ 24 minutes for every symbol, PARTIAL ≥ 12, POOR below. Informational; the calibration rule below is unchanged.', '',
    `## Readiness (pre-registered rule, declared ${CALIBRATION_RULE.declared}): **${readiness.ready ? 'READY' : 'NOT READY'}**`, ''];
  for (const r of readiness.reasonsNotReady) md.push(`- ${r}`);
  md.push('', '| Premium bucket | Quotes 15:00–15:30 | Median half-spread | p75 | V1 at median mid | Eligible |', '|---|---:|---:|---:|---:|---|');
  for (const b of readiness.buckets) md.push(`| ${b.bucket} | ${b.quotes} | ${f(b.medianHalfSpread)} | ${f(b.p75HalfSpread)} | ${f(b.v1HalfSpreadAtMedianMid)} | ${b.eligible ? 'yes' : 'no'} |`);
  md.push('', `## Close vs quote (last snapshot ${CLOSE_WINDOW_IST.join('–')} IST vs bhavcopy close; traded contracts)`, '',
    `Observations: ${obs.length}. Buy cost = ask − close; sell cost = close − bid. The EOD model charges V1 half-spread on both.`, '',
    '| Close bucket | n | Median buy cost | Median sell cost | p75 cost | Median V1 | V1 covers both sides | Close inside bid/ask |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const b of gaps) md.push(`| ${b.bucket} | ${b.n} | ${f(b.medianBuyCost)} | ${f(b.medianSellCost)} | ${f(b.p75Cost)} | ${f(b.medianModel)} | ${p(b.modelCoversBoth)} | ${p(b.closeInsideQuote)} |`);
  md.push('', 'Measurement only. No model changes until the pre-registered rule is met (docs/EXECUTION_CALIBRATION.md).');
  writeFileSync(`${base}.md`, md.join('\n') + '\n');
  console.error(`Sessions ${sessions.length}, quotes ${quotes.length}, close-gap observations ${obs.length}; readiness ${readiness.ready ? 'READY' : 'NOT READY'}. Report: ${base}.md`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
