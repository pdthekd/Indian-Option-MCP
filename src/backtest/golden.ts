/**
 * Golden (frozen) backtest results and exact comparison.
 *
 * A golden file pins what a run produced: strategy fingerprint, cost and execution model, data
 * version, totals and every trade's gross / costs / net. `compareGolden` lists every difference;
 * an empty list means the run reproduced the frozen result exactly (to the paisa).
 * Golden files are never edited to make a run pass; a changed result needs a new, documented file.
 */

import type { BacktestResult } from './eod-engine.js';
import type { DataVersion } from './data-version.js';

export interface GoldenTrade {
  id: string;
  entryDate: string;
  settlementPrice: number;
  grossPnL: number;
  totalCosts: number;
  slippage: number;
  netPnL: number;
}

export interface GoldenResult {
  schema: 1;
  label: string;
  strategyId: string;
  strategyVersion: string;
  strategyFingerprint: string;
  brokeragePlanId: string;
  spreadModel: string;
  from: string;
  to: string;
  data: DataVersion;
  trades: number;
  skipped: number;
  grossTotal: number;
  costsTotal: number;
  netTotal: number;
  perTrade: GoldenTrade[];
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function toGolden(label: string, result: BacktestResult, data: DataVersion): GoldenResult {
  const perTrade = result.trades.map((t) => ({
    id: t.id,
    entryDate: t.entryDate,
    settlementPrice: t.settlementPrice,
    grossPnL: r2(t.pnl.grossPnL),
    totalCosts: r2(t.pnl.totalCosts),
    slippage: r2(t.pnl.slippage),
    netPnL: r2(t.pnl.netPnL),
  }));
  const sum = (k: 'grossPnL' | 'totalCosts' | 'netPnL') => r2(perTrade.reduce((a, t) => a + t[k], 0));
  return {
    schema: 1,
    label,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    strategyFingerprint: result.strategyFingerprint,
    brokeragePlanId: result.brokeragePlanId,
    spreadModel: result.spreadModel,
    from: result.from,
    to: result.to,
    data,
    trades: result.trades.length,
    skipped: result.skipped.length,
    grossTotal: sum('grossPnL'),
    costsTotal: sum('totalCosts'),
    netTotal: sum('netPnL'),
    perTrade,
  };
}

/**
 * Every difference between a fresh run and a golden file. Empty = exact reproduction.
 * Raw data, strategy, models and every trade must match exactly. The normalized-data hash is compared
 * only when both sides used the same normalizer version (a format change alters those bytes but not
 * the raw data); `notes` says when it was not compared.
 */
export function compareGolden(expected: GoldenResult, actual: GoldenResult, notes: string[] = []): string[] {
  const diffs: string[] = [];
  const keys = ['strategyId', 'strategyVersion', 'strategyFingerprint', 'brokeragePlanId', 'spreadModel', 'from', 'to',
    'trades', 'skipped', 'grossTotal', 'costsTotal', 'netTotal'] as const;
  for (const k of keys) if (expected[k] !== actual[k]) diffs.push(`${k}: expected ${expected[k]}, got ${actual[k]}`);
  for (const k of ['days', 'rawSha256'] as const) {
    if (expected.data[k] !== actual.data[k]) diffs.push(`data.${k}: expected ${expected.data[k]}, got ${actual.data[k]}`);
  }
  const ev = expected.data.normalizerVersion ?? 1, av = actual.data.normalizerVersion ?? 1;
  if (ev === av) {
    if (expected.data.normalizedSha256 !== actual.data.normalizedSha256) {
      diffs.push(`data.normalizedSha256: expected ${expected.data.normalizedSha256}, got ${actual.data.normalizedSha256}`);
    }
  } else {
    notes.push(`normalized-data hash not compared: golden used normalizer v${ev}, this run v${av} (raw data hash compared exactly)`);
  }
  const byId = new Map(actual.perTrade.map((t) => [t.id, t]));
  for (const e of expected.perTrade) {
    const a = byId.get(e.id);
    if (!a) { diffs.push(`trade ${e.id}: missing`); continue; }
    for (const k of ['entryDate', 'settlementPrice', 'grossPnL', 'totalCosts', 'slippage', 'netPnL'] as const) {
      if (e[k] !== a[k]) diffs.push(`trade ${e.id} ${k}: expected ${e[k]}, got ${a[k]}`);
    }
    byId.delete(e.id);
  }
  for (const id of byId.keys()) diffs.push(`trade ${id}: unexpected`);
  return diffs;
}
