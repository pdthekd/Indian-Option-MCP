/**
 * Capital / margin estimates for defined-risk option structures in a backtest.
 *
 * No exchange SPAN files are used, so these are ESTIMATES with stated methods, never a broker's
 * actual requirement:
 *  - MAX_LOSS: the structure's worst-case settlement loss (widest wing × quantity), premium credit
 *    NOT netted. For a hedged spread this is close to what SPAN blocks before exposure margin.
 *  - SPAN_PROXY: MAX_LOSS + exposure margin of 2 % of the underlying notional (S × quantity) for
 *    one short side. UNVERIFIED PROXY — check against the broker's basket-margin calculator.
 * Capital metrics use the more conservative SPAN_PROXY unless stated.
 */

import type { BacktestTrade } from '../backtest/eod-engine.js';

export const EXPOSURE_MARGIN_PCT = 0.02;

export interface TradeMargin {
  tradeId: string;
  entryDate: string;
  expiry: string;
  quantity: number;
  putWingWidth: number;
  callWingWidth: number;
  creditAtFill: number;
  maxLoss: number;
  spanProxy: number;
  /** Trading days the capital is blocked (entry day to expiry day, inclusive). */
  daysBlocked: number;
  netPnL: number;
}

export interface CapitalSummary {
  method: 'SPAN_PROXY';
  trades: number;
  maxCapitalPerTrade: number;
  meanCapitalPerTrade: number;
  maxConcurrentPositions: number;
  /** Share of trading days with capital blocked. */
  utilization: number;
  maxDrawdown: number;
  /** Capital needed to keep trading through the observed history: max blocked + max net drawdown. */
  sustainingCapital: number;
  totalNet: number;
  returnOnMeanDeployed: number;
  returnOnSustainingCapital: number;
  annualizedOnSustainingCapital: number;
  years: number;
  notes: string[];
}

function widths(t: BacktestTrade): { put: number; call: number } {
  const of = (type: 'CE' | 'PE') => t.legs.filter((l) => l.type === type).map((l) => l.strike);
  const span = (k: number[]) => (k.length >= 2 ? Math.max(...k) - Math.min(...k) : Number.POSITIVE_INFINITY);
  return { put: span(of('PE')), call: span(of('CE')) };
}

export function tradeMargin(t: BacktestTrade, tradeDates: readonly string[], underlyingAtEntry: number): TradeMargin {
  const w = widths(t);
  const qty = Math.max(...t.legs.map((l) => l.quantity));
  if (!Number.isFinite(w.put) || !Number.isFinite(w.call)) throw new Error(`${t.id}: not a two-winged structure; margin method does not apply`);
  if (new Set(t.legs.map((l) => l.quantity)).size !== 1) throw new Error(`${t.id}: unequal leg quantities; margin method does not apply`);
  const credit = t.legs.reduce((a, l) => a + (l.side === 'SELL' ? 1 : -1) * l.fillPrice * l.quantity, 0);
  const maxLoss = Math.max(w.put, w.call) * qty;
  const spanProxy = maxLoss + EXPOSURE_MARGIN_PCT * underlyingAtEntry * qty;
  const daysBlocked = tradeDates.filter((d) => d >= t.entryDate && d <= t.expiry).length;
  return {
    tradeId: t.id, entryDate: t.entryDate, expiry: t.expiry, quantity: qty,
    putWingWidth: w.put, callWingWidth: w.call, creditAtFill: Math.round(credit * 100) / 100,
    maxLoss, spanProxy: Math.round(spanProxy * 100) / 100, daysBlocked, netPnL: t.pnl.netPnL,
  };
}

export function maxDrawdown(nets: readonly number[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const n of nets) { eq += n; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return Math.round(dd * 100) / 100;
}

export function capitalSummary(margins: readonly TradeMargin[], tradeDates: readonly string[], from: string, to: string): CapitalSummary {
  const inRange = tradeDates.filter((d) => d >= from && d <= to);
  const blocked = new Set<string>();
  let maxConcurrent = 0;
  for (const d of inRange) {
    const n = margins.filter((m) => d >= m.entryDate && d <= m.expiry).length;
    if (n > 0) blocked.add(d);
    maxConcurrent = Math.max(maxConcurrent, n);
  }
  const caps = margins.map((m) => m.spanProxy);
  const maxCap = caps.length ? Math.max(...caps) : 0;
  const meanCap = caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : 0;
  const dd = maxDrawdown(margins.map((m) => m.netPnL));
  const totalNet = Math.round(margins.reduce((a, m) => a + m.netPnL, 0) * 100) / 100;
  const sustaining = maxCap * Math.max(1, maxConcurrent) + dd;
  const years = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365.25 * 86_400_000);
  const r = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    method: 'SPAN_PROXY',
    trades: margins.length,
    maxCapitalPerTrade: Math.round(maxCap * 100) / 100,
    meanCapitalPerTrade: Math.round(meanCap * 100) / 100,
    maxConcurrentPositions: maxConcurrent,
    utilization: inRange.length ? r(blocked.size / inRange.length) : 0,
    maxDrawdown: dd,
    sustainingCapital: Math.round(sustaining * 100) / 100,
    totalNet,
    returnOnMeanDeployed: meanCap ? r(totalNet / meanCap) : 0,
    returnOnSustainingCapital: sustaining ? r(totalNet / sustaining) : 0,
    annualizedOnSustainingCapital: sustaining && years > 0 ? r(totalNet / sustaining / years) : 0,
    years: r(years),
    notes: [
      'SPAN_PROXY = widest wing × quantity + 2 % exposure margin on S × quantity (one short side). UNVERIFIED; actual broker margin may differ either way.',
      'Premium credit is not netted against margin (conservative).',
      'Returns are simple (no compounding) on a fixed 1-lot position.',
    ],
  };
}
