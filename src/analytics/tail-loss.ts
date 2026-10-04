/**
 * Tail-loss analysis of NET trade results (and, when supplied, end-of-day mark-to-market paths).
 *
 * Every number is NET of modelled charges and spread. With ~100 trades the 99 % figures rest on
 * one or two observations; they describe this sample, not a forecast.
 */

import type { BacktestTrade } from '../backtest/eod-engine.js';

export type SettlementOutcome = 'ALL_OTM' | 'SHORT_BREACHED' | 'WING_FULLY_BREACHED';

export interface TradeTail {
  tradeId: string;
  netPnL: number;
  outcome: SettlementOutcome;
  /** Worst end-of-day open P&L before expiry (at bhavcopy closes, after entry charges and spread), or null if no marks. */
  worstEodMtm: number | null;
  /** Max theoretical net loss: widest wing × qty − credit + entry charges + spread paid. */
  theoreticalMaxNetLoss: number;
  /** |S_expiry / S_entry − 1| over the holding period, if known. */
  underlyingMove: number | null;
}

export interface TailSummary {
  trades: number;
  totalNet: number;
  sumWins: number;
  sumLosses: number;
  worst: Array<{ tradeId: string; netPnL: number; outcome: SettlementOutcome }>;
  worst5ShareOfLosses: number;
  worst10ShareOfLosses: number;
  /** Total net if the k worst trades had not happened (illustrates dependence on tails, not a strategy). */
  netExcludingWorst: Record<'1' | '5' | '10', number>;
  var95: number;
  es95: number;
  var99: number;
  es99: number;
  outcomes: Record<SettlementOutcome, { count: number; net: number }>;
  averageWin: number;
  averageLoss: number;
  winsNeededToRepayWorst: number;
  maxConsecutiveLosses: number;
  realizedWorstVsTheoretical: number;
  tradesWithEodMtmBelowMinus5000: number;
  recoveredFromEodMtmBelowMinus5000: number;
  worstEodMtm: number | null;
  notes: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function settlementOutcome(t: BacktestTrade): SettlementOutcome {
  let shortItm = false, longItm = false;
  for (const l of t.legs) {
    if (l.settlementValuePerUnit > 0) {
      if (l.side === 'SELL') shortItm = true;
      else longItm = true;
    }
  }
  return longItm ? 'WING_FULLY_BREACHED' : shortItm ? 'SHORT_BREACHED' : 'ALL_OTM';
}

export function theoreticalMaxNetLoss(t: BacktestTrade): number {
  const qty = Math.max(...t.legs.map((l) => l.quantity));
  const span = (type: 'CE' | 'PE') => {
    const k = t.legs.filter((l) => l.type === type).map((l) => l.strike);
    return Math.max(...k) - Math.min(...k);
  };
  const creditAtClose = t.legs.reduce((a, l) => a + (l.side === 'SELL' ? 1 : -1) * l.close * l.quantity, 0);
  const entryCharges = t.pnl.totalCosts - t.pnl.slippage; // includes settlement charges actually incurred
  return r2(Math.max(span('PE'), span('CE')) * qty - creditAtClose + entryCharges + t.pnl.slippage);
}

/** Empirical VaR / expected shortfall on losses (positive numbers = loss). */
export function varEs(nets: readonly number[], level: number): { var: number; es: number } {
  if (nets.length === 0) return { var: 0, es: 0 };
  const losses = [...nets].map((n) => -n).sort((a, b) => b - a);
  // Round before ceil: (1 − 0.95) × 100 is 5.000000000000004 in floating point.
  const k = Math.max(1, Math.ceil(Math.round((1 - level) * losses.length * 1e9) / 1e9));
  const tail = losses.slice(0, k);
  return { var: r2(tail[tail.length - 1]), es: r2(tail.reduce((a, b) => a + b, 0) / tail.length) };
}

export function tailSummary(rows: readonly TradeTail[]): TailSummary {
  const nets = rows.map((r) => r.netPnL);
  const wins = nets.filter((n) => n > 0), losses = nets.filter((n) => n <= 0);
  const sumLosses = r2(losses.reduce((a, b) => a + b, 0));
  const sorted = [...rows].sort((a, b) => a.netPnL - b.netPnL);
  const worstK = (k: number) => sorted.slice(0, k).reduce((a, r) => a + r.netPnL, 0);
  const total = r2(nets.reduce((a, b) => a + b, 0));
  let streak = 0, maxStreak = 0;
  for (const n of nets) { streak = n <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const outcomes: TailSummary['outcomes'] = { ALL_OTM: { count: 0, net: 0 }, SHORT_BREACHED: { count: 0, net: 0 }, WING_FULLY_BREACHED: { count: 0, net: 0 } };
  for (const r of rows) { outcomes[r.outcome].count++; outcomes[r.outcome].net = r2(outcomes[r.outcome].net + r.netPnL); }
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const worst = sorted[0];
  const v95 = varEs(nets, 0.95), v99 = varEs(nets, 0.99);
  const mtm = rows.map((r) => r.worstEodMtm).filter((x): x is number => x !== null);
  const deep = rows.filter((r) => r.worstEodMtm !== null && r.worstEodMtm < -5000);
  return {
    trades: rows.length,
    totalNet: total,
    sumWins: r2(wins.reduce((a, b) => a + b, 0)),
    sumLosses,
    worst: sorted.slice(0, 10).map((r) => ({ tradeId: r.tradeId, netPnL: r.netPnL, outcome: r.outcome })),
    worst5ShareOfLosses: sumLosses ? r2(worstK(5) / sumLosses) : 0,
    worst10ShareOfLosses: sumLosses ? r2(worstK(10) / sumLosses) : 0,
    netExcludingWorst: { '1': r2(total - worstK(1)), '5': r2(total - worstK(5)), '10': r2(total - worstK(10)) },
    var95: v95.var, es95: v95.es, var99: v99.var, es99: v99.es,
    outcomes,
    averageWin: r2(avgWin),
    averageLoss: r2(avgLoss),
    winsNeededToRepayWorst: worst && avgWin > 0 ? r2(-worst.netPnL / avgWin) : 0,
    maxConsecutiveLosses: maxStreak,
    realizedWorstVsTheoretical: worst ? r2(-worst.netPnL / worst.theoreticalMaxNetLoss) : 0,
    tradesWithEodMtmBelowMinus5000: deep.length,
    recoveredFromEodMtmBelowMinus5000: deep.filter((r) => r.netPnL > 0).length,
    worstEodMtm: mtm.length ? r2(Math.min(...mtm)) : null,
    notes: [
      'All figures NET of modelled charges and spread.',
      'VaR/ES are empirical over this sample; 99 % figures rest on 1–2 trades.',
      'EOD mark-to-market uses bhavcopy closes (not tradable prices) and ignores intraday extremes: true intraday drawdowns were larger.',
    ],
  };
}
