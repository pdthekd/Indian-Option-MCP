/**
 * @module analytics/cost-sensitivity
 *
 * Re-evaluates a set of trades under heavier cost assumptions and computes
 * break-even quantities. A strategy whose edge disappears under WORSE costs
 * should not be promoted.
 */

import type { TradePnL } from '../pnl/pnl-engine.js';
import { computeNetMetrics, type NetMetrics, type VerdictOptions } from './performance.js';

export interface CostScenario {
  name: string;
  /** Multiplier on brokerage. */
  brokerage: number;
  /** Multiplier on statutory charges (STT, stamp duty, SEBI, GST) — models future rate hikes. */
  statutory: number;
  /** Multiplier on exchange + IPFT charges. */
  exchange: number;
  /** Multiplier on observed slippage. */
  slippage: number;
  /** Additional slippage per trade in ₹ (e.g. wider spreads). */
  extraSlippagePerTrade: number;
}

export const STANDARD_SCENARIOS: readonly CostScenario[] = Object.freeze([
  { name: 'BASE', brokerage: 1, statutory: 1, exchange: 1, slippage: 1, extraSlippagePerTrade: 0 },
  { name: 'WORSE', brokerage: 1.5, statutory: 1.25, exchange: 1.25, slippage: 2, extraSlippagePerTrade: 0 },
  { name: 'SEVERE', brokerage: 2, statutory: 1.5, exchange: 1.5, slippage: 3, extraSlippagePerTrade: 0 },
]);

/** Apply a scenario to one trade's cost components (gross unchanged). */
export function applyScenario(t: TradePnL, s: CostScenario): TradePnL {
  const brokerage = t.brokerage * s.brokerage;
  const stt = t.stt * s.statutory;
  const stamp = t.stampDuty * s.statutory;
  const sebi = t.sebiCharges * s.statutory;
  const exch = t.exchangeCharges * s.exchange;
  const gst = t.gst * Math.max(s.brokerage, s.exchange, s.statutory); // conservative
  const slip = t.slippage * s.slippage + s.extraSlippagePerTrade;
  const total = brokerage + stt + stamp + sebi + exch + gst + t.otherCosts + slip;
  const net = t.grossPnL - total;
  return {
    ...t, brokerage, stt, stampDuty: stamp, sebiCharges: sebi, exchangeCharges: exch, gst, slippage: slip,
    totalCosts: total, netPnL: net,
    classification: net > 0.005 ? 'NET_PROFIT' : net < -0.005 ? 'NET_LOSS' : 'NET_BREAKEVEN',
    grossProfitNetLoss: t.grossPnL > 0 && net <= 0,
  };
}

export interface BreakEven {
  /** Average gross P&L per trade needed to cover average costs. */
  breakEvenGrossPerTrade: number;
  /** Win rate needed at the observed average NET win / loss sizes. */
  breakEvenWinRate: number | null;
  /** Max average cost per trade before net expectancy hits zero. */
  breakEvenCostPerTrade: number;
  /** Max additional slippage per trade (₹) before net expectancy hits zero. */
  breakEvenExtraSlippagePerTrade: number;
}

export function breakEven(trades: TradePnL[]): BreakEven {
  const n = trades.length || 1;
  const avgGross = trades.reduce((a, t) => a + t.grossPnL, 0) / n;
  const avgCost = trades.reduce((a, t) => a + t.totalCosts, 0) / n;
  const m = computeNetMetrics(trades, { minTrades: 0 });
  const w = m.averageWin, l = Math.abs(m.averageLoss);
  return {
    breakEvenGrossPerTrade: avgCost,
    breakEvenWinRate: w > 0 && l > 0 ? l / (w + l) : null,
    breakEvenCostPerTrade: avgGross,
    breakEvenExtraSlippagePerTrade: avgGross - avgCost,
  };
}

export interface SensitivityReport {
  scenarios: Array<{ scenario: CostScenario; metrics: NetMetrics }>;
  breakEven: BreakEven;
  /** True only if net expectancy is positive in EVERY scenario. */
  survivesAllScenarios: boolean;
}

export function costSensitivity(
  trades: TradePnL[],
  scenarios: readonly CostScenario[] = STANDARD_SCENARIOS,
  opts: VerdictOptions = {},
): SensitivityReport {
  const results = scenarios.map((s) => ({ scenario: s, metrics: computeNetMetrics(trades.map((t) => applyScenario(t, s)), opts) }));
  return {
    scenarios: results,
    breakEven: breakEven(trades),
    survivesAllScenarios: results.every((r) => r.metrics.verdict.startsWith('POSITIVE')),
  };
}
