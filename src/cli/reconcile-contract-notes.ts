#!/usr/bin/env node
/**
 * Reconcile the cost model against normalized contract notes (schema 'contract-note/v1').
 *
 *   node dist/reconcile-cli.mjs <notes.json | notes-dir> [--brokerage-plan ZERODHA-FO-r3] [--details]
 *
 * Input: a JSON array of notes, or a directory of *.json notes, produced by
 * scripts/contract_note_xlsx_to_json.py and kept OUTSIDE the repository.
 * Output: aggregate results only (no order ids). --details adds per-day component differences.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileNote, summarize, COMPONENTS } from '../costs/contract-note-reconciliation.js';
import { DEFAULT_BROKERAGE_PLAN } from '../costs/transaction-cost-engine.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const input = process.argv[2];
  if (!input || input.startsWith('--')) throw new Error('Usage: reconcile-cli <notes.json | dir> [--brokerage-plan ID] [--details]');
  const files = statSync(input).isDirectory() ? readdirSync(input).filter((f) => f.endsWith('.json')).map((f) => join(input, f)) : [input];
  const notes = files.flatMap((f) => { const j = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(j) ? j : [j]; });
  const plan = arg('brokerage-plan') ?? DEFAULT_BROKERAGE_PLAN;
  const rows = notes.map((n) => reconcileNote(n, { brokeragePlanId: plan })).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const s = summarize(rows);
  console.log(`Contract notes: ${s.notes} (${rows[0]?.tradeDate} → ${rows[rows.length - 1]?.tradeDate}), fills ${rows.reduce((a, r) => a + r.fills, 0)}, orders ${rows.reduce((a, r) => a + r.orders, 0)}; plan ${plan}`);
  console.log(`Exact on every component: ${s.exactNotes}/${s.notes}`);
  console.log(`Total charges: model ₹${s.modelTotal.toFixed(2)} vs reported ₹${s.reportedTotal.toFixed(2)} (diff ₹${s.diffTotal.toFixed(2)}); max daily |diff| ₹${s.maxAbsDailyDiff.toFixed(2)}`);
  console.log(`Days with a mismatch, by component: ${COMPONENTS.map((k) => `${k} ${s.componentMismatches[k]}`).join(', ')}`);
  if (process.argv.includes('--details')) {
    for (const r of rows.filter((x) => !x.exact)) {
      console.log(`  ${r.tradeDate}: ${COMPONENTS.filter((k) => r.diff[k] !== 0).map((k) => `${k} model ${r.model[k]} reported ${r.reported[k]}`).join('; ')}`);
    }
  }
  console.log(`VERDICT: ${s.verdict}`);
  return s.verdict === 'PASS' ? 0 : 2;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
