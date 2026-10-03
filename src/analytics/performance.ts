/**
 * @module analytics/performance
 *
 * Strategy performance metrics computed from NET P&L (PnLEngine output).
 * Gross figures are reported alongside but never drive the verdict.
 */

import type { TradePnL } from '../pnl/pnl-engine.js';

export type Verdict =
  | 'UNKNOWN'
  | 'NEGATIVE NET EXPECTANCY'
  | 'PROFITABLE BEFORE COSTS BUT NOT VALIDATED AFTER COSTS'
  | 'POSITIVE NET EXPECTANCY IN SAMPLE — NOT VALIDATED OUT-OF-SAMPLE';

export interface NetMetrics {
  trades: number;
  grossTotal: number;
  costsTotal: number;
  netTotal: number;
  /** Mean net P&L per trade. */
  netExpectancy: number;
  grossExpectancy: number;
  /** Standard error of the mean net P&L. */
  netExpectancyStdErr: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  /** Σ net wins / |Σ net losses|; Infinity if no losses. */
  profitFactor: number;
  maxDrawdown: number;
  longestLosingStreak: number;
  /** Per-trade Sharpe (mean/sd of net trade P&L) — NOT annualised; meaningful only with many trades. */
  perTradeSharpe: number | null;
  perTradeSortino: number | null;
  costsAsPctOfGrossProfit: number | null;
  verdict: Verdict;
  verdictReason: string;
}

export interface VerdictOptions {
  /** Minimum sample before any non-UNKNOWN verdict (default 100). */
  minTrades?: number;
  /** Mean − z·SE must exceed 0 to call expectancy positive (default z = 2). */
  z?: number;
}

export function computeNetMetrics(trades: TradePnL[], opts: VerdictOptions = {}): NetMetrics {
  const n = trades.length;
  const net = trades.map((t) => t.netPnL);
  const gross = trades.map((t) => t.grossPnL);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const netTotal = sum(net);
  const grossTotal = sum(gross);
  const costsTotal = sum(trades.map((t) => t.totalCosts));
  const mean = n ? netTotal / n : 0;
  const sd = n > 1 ? Math.sqrt(sum(net.map((x) => (x - mean) ** 2)) / (n - 1)) : 0;
  const downside = n > 1 ? Math.sqrt(sum(net.map((x) => Math.min(x, 0) ** 2)) / (n - 1)) : 0;
  const wins = net.filter((x) => x > 0.005);
  const losses = net.filter((x) => x < -0.005);

  let peak = 0, cum = 0, maxDD = 0, streak = 0, longest = 0;
  for (const x of net) {
    cum += x;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    streak = x < -0.005 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  const grossWins = sum(gross.filter((x) => x > 0));
  const se = n > 1 ? sd / Math.sqrt(n) : Infinity;
  const minTrades = opts.minTrades ?? 100;
  const z = opts.z ?? 2;

  let verdict: Verdict;
  let reason: string;
  if (n < minTrades) {
    verdict = 'UNKNOWN';
    reason = `Only ${n} trades; at least ${minTrades} required.`;
  } else if (mean - z * se > 0) {
    verdict = 'POSITIVE NET EXPECTANCY IN SAMPLE — NOT VALIDATED OUT-OF-SAMPLE';
    reason = `Net mean ₹${mean.toFixed(2)} exceeds ${z}·SE (₹${(z * se).toFixed(2)}).`;
  } else if (mean <= 0 && grossTotal / n > 0) {
    verdict = 'PROFITABLE BEFORE COSTS BUT NOT VALIDATED AFTER COSTS';
    reason = `Gross mean ₹${(grossTotal / n).toFixed(2)} > 0 but net mean ₹${mean.toFixed(2)} ≤ 0.`;
  } else if (mean + z * se < 0 || mean <= 0) {
    verdict = 'NEGATIVE NET EXPECTANCY';
    reason = `Net mean ₹${mean.toFixed(2)} (SE ₹${se.toFixed(2)}).`;
  } else {
    verdict = 'UNKNOWN';
    reason = `Net mean ₹${mean.toFixed(2)} not distinguishable from 0 at z=${z} (SE ₹${se.toFixed(2)}).`;
  }

  return {
    trades: n,
    grossTotal: round(grossTotal),
    costsTotal: round(costsTotal),
    netTotal: round(netTotal),
    netExpectancy: round(mean),
    grossExpectancy: round(n ? grossTotal / n : 0),
    netExpectancyStdErr: Number.isFinite(se) ? round(se) : Infinity,
    winRate: n ? wins.length / n : 0,
    averageWin: wins.length ? round(sum(wins) / wins.length) : 0,
    averageLoss: losses.length ? round(sum(losses) / losses.length) : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : Infinity,
    maxDrawdown: round(maxDD),
    longestLosingStreak: longest,
    perTradeSharpe: sd > 0 ? mean / sd : null,
    perTradeSortino: downside > 0 ? mean / downside : null,
    costsAsPctOfGrossProfit: grossWins > 0 ? (costsTotal / grossWins) * 100 : null,
    verdict,
    verdictReason: reason,
  };
}

function round(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
