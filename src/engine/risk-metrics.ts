/**
 * @module engine/risk-metrics
 * Risk arithmetic: risk-reward ratio, fixed-fraction position sizing, and probability of profit
 * from a position's actual expiry payoff.
 */

import { normCDF } from '../utils/math.js';

/**
 * Risk-reward ratio: Max Loss / Max Profit
 * A ratio of 1:2 means for every ₹1 risked, potential reward is ₹2.
 */
export function riskRewardRatio(maxProfit: number, maxLoss: number): number {
  if (maxLoss === 0) return Infinity;
  if (!isFinite(maxProfit)) return Infinity;
  return Math.abs(maxProfit / maxLoss);
}

/**
 * Position size from a fixed-fraction risk budget.
 *
 * @param capital - Total trading capital in ₹ (> 0)
 * @param riskPercent - Max % of capital to risk per trade (0 < x ≤ 100)
 * @param maxLossPerLotRupees - Worst-case loss of ONE lot of the strategy in ₹,
 *   INCLUDING estimated transaction costs and slippage. Must be finite and > 0;
 *   strategies with unlimited loss cannot be sized this way.
 * @returns Whole lots (rounded down) and the resulting risk.
 *
 * (Baseline multiplied a per-lot rupee loss by the lot size again, so a
 * ₹5,000-per-lot strategy was treated as ₹3.75 lakh per lot.)
 */
export function optimalPositionSize(
  capital: number,
  riskPercent: number,
  maxLossPerLotRupees: number,
): { lots: number; riskBudget: number; totalRisk: number; capitalAtRiskPercent: number } {
  if (!(capital > 0) || !Number.isFinite(capital)) throw new Error('capital must be a positive finite number');
  if (!(riskPercent > 0 && riskPercent <= 100)) throw new Error('riskPercent must be in (0, 100]');
  if (!(maxLossPerLotRupees > 0) || !Number.isFinite(maxLossPerLotRupees)) {
    throw new Error('maxLossPerLotRupees must be a positive finite number (unlimited-loss strategies cannot be sized)');
  }

  const riskBudget = capital * (riskPercent / 100);
  const lots = Math.floor(riskBudget / maxLossPerLotRupees);
  const totalRisk = lots * maxLossPerLotRupees;

  return {
    lots,
    riskBudget,
    totalRisk,
    capitalAtRiskPercent: (totalRisk / capital) * 100,
  };
}

/** Legs accepted by {@link probabilityOfProfitFromLegs}. */
export interface PopLeg {
  type: 'CE' | 'PE';
  strike: number;
  premium: number;
  qty: number;
  action: 'BUY' | 'SELL';
}

/**
 * Probability that the strategy's expiry P&L, NET of `costs`, is > 0, under a
 * log-normal terminal distribution whose MEAN equals spot (zero drift,
 * martingale; median = spot·e^(−σ²T/2)).
 *
 * The profitable region is derived from the actual payoff (exact breakevens),
 * not from a CREDIT/DEBIT label.
 *
 * Model limits: single IV for all strikes (ignores skew), no drift, European
 * expiry. Treat as a rough model probability, not a forecast.
 */
export function probabilityOfProfitFromLegs(
  legs: PopLeg[],
  lotSize: number,
  spotPrice: number,
  iv: number,
  timeToExpiryYears: number,
  costs = 0,
): number {
  if (!(spotPrice > 0) || !(iv > 0) || !(timeToExpiryYears > 0) || legs.length === 0) {
    throw new Error('POP requires spot > 0, iv > 0, T > 0 and at least one leg');
  }
  const sigma = iv * Math.sqrt(timeToExpiryYears);
  const cdf = (x: number): number => {
    if (x <= 0) return 0;
    if (!Number.isFinite(x)) return 1;
    return normCDF((Math.log(x / spotPrice) + (sigma * sigma) / 2) / sigma);
  };
  const pnl = (s: number): number => {
    let t = -costs;
    for (const l of legs) {
      const intrinsic = l.type === 'CE' ? Math.max(s - l.strike, 0) : Math.max(l.strike - s, 0);
      t += (l.action === 'BUY' ? 1 : -1) * (intrinsic - l.premium) * l.qty * lotSize;
    }
    return t;
  };

  // Region boundaries: 0, every strike, every exact zero crossing, ∞.
  const kinks = Array.from(new Set([0, ...legs.map((l) => l.strike)])).sort((a, b) => a - b);
  const pts: number[] = [...kinks];
  for (let i = 0; i < kinks.length - 1; i++) {
    const a = pnl(kinks[i]), b = pnl(kinks[i + 1]);
    if (a * b < 0) pts.push(kinks[i] + (-a * (kinks[i + 1] - kinks[i])) / (b - a));
  }
  const lastK = kinks[kinks.length - 1];
  const tailSlope = pnl(lastK + 1) - pnl(lastK);
  const lastV = pnl(lastK);
  if (tailSlope !== 0 && lastV * tailSlope < 0) pts.push(lastK - lastV / tailSlope);
  pts.sort((a, b) => a - b);
  pts.push(Infinity);

  let p = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const mid = Number.isFinite(b) ? (a + b) / 2 : a + Math.max(1, a * 0.01);
    if (pnl(mid) > 0) p += cdf(b) - cdf(a);
  }
  return Math.max(0, Math.min(1, p));
}
