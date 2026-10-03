/**
 * @module engine/risk-metrics
 * Risk management calculations: Probability of Profit, VaR, Expected Move,
 * Kelly Criterion, and position sizing for Indian options strategies.
 */

import { normCDF } from '../utils/math.js';

/**
 * @deprecated Guesses the profitable region from a CREDIT/DEBIT label, which
 * is wrong for e.g. debit butterflies and calendars. Use
 * {@link probabilityOfProfitFromLegs}. Kept only for backwards compatibility;
 * not exposed through MCP tools.
 *
 * Calculate Probability of Profit (POP) for an options strategy.
 * Uses the log-normal distribution assumption.
 *
 * For CREDIT strategies: P(spot stays between breakevens at expiry)
 * For DEBIT strategies: P(spot moves beyond breakeven)
 *
 * @param breakevens - Breakeven price(s) of the strategy
 * @param spotPrice - Current underlying price
 * @param iv - Implied volatility (annualized decimal)
 * @param daysToExpiry - Calendar days to expiry
 * @param strategyType - 'CREDIT' or 'DEBIT'
 */
export function probabilityOfProfit(
  breakevens: number[],
  spotPrice: number,
  iv: number,
  daysToExpiry: number,
  strategyType: 'CREDIT' | 'DEBIT'
): number {
  if (breakevens.length === 0 || spotPrice <= 0 || iv <= 0 || daysToExpiry <= 0) return 0;

  const T = daysToExpiry / 365;
  const sigma = iv * Math.sqrt(T);

  // Using log-normal distribution: P(S < K) = N((ln(K/S) - σ²/2) / σ)
  function probBelow(targetPrice: number): number {
    if (targetPrice <= 0) return 0;
    const d = (Math.log(targetPrice / spotPrice) - (sigma * sigma) / 2) / sigma;
    return normCDF(d);
  }

  const sortedBE = [...breakevens].sort((a, b) => a - b);

  if (sortedBE.length === 1) {
    const probBelowBE = probBelow(sortedBE[0]);
    // Credit: profitable if stays on one side; Debit: profitable if moves past
    return strategyType === 'CREDIT'
      ? (sortedBE[0] > spotPrice ? probBelowBE : 1 - probBelowBE)
      : (sortedBE[0] > spotPrice ? 1 - probBelowBE : probBelowBE);
  }

  if (sortedBE.length === 2) {
    const probBetween = probBelow(sortedBE[1]) - probBelow(sortedBE[0]);
    return strategyType === 'CREDIT' ? probBetween : 1 - probBetween;
  }

  // 3+ breakevens: sum the profitable regions
  if (strategyType === 'CREDIT') {
    // Profitable between pairs of breakevens
    let pop = 0;
    for (let i = 0; i < sortedBE.length - 1; i += 2) {
      pop += probBelow(sortedBE[i + 1]) - probBelow(sortedBE[i]);
    }
    return Math.max(0, Math.min(1, pop));
  } else {
    // Profitable outside breakeven pairs
    let probInsideUnprofitable = 0;
    for (let i = 0; i < sortedBE.length - 1; i += 2) {
      probInsideUnprofitable += probBelow(sortedBE[i + 1]) - probBelow(sortedBE[i]);
    }
    return Math.max(0, Math.min(1, 1 - probInsideUnprofitable));
  }
}

/**
 * Calculate Value at Risk (VaR) — maximum expected loss over a time horizon
 * at a given confidence level.
 *
 * Parametric VaR = Position Value × σ × √(days) × z-score
 *
 * @param positionValue - Total position value (premium paid or margin blocked)
 * @param iv - Implied volatility (annualized decimal)
 * @param daysHorizon - Time horizon in days
 * @param confidence - Confidence level (default 0.95 for 95%)
 */
export function calculateVaR(
  positionValue: number,
  iv: number,
  daysHorizon: number,
  confidence: number = 0.95
): number {
  // Z-scores for common confidence levels
  const zScores: Record<number, number> = {
    0.90: 1.2816,
    0.95: 1.6449,
    0.99: 2.3263,
  };
  const z = zScores[confidence] ?? -1 * Math.log(1 - confidence) * 1.5; // rough approximation

  const dailyVol = iv / Math.sqrt(252);
  return Math.abs(positionValue) * dailyVol * Math.sqrt(daysHorizon) * z;
}

/**
 * Calculate Expected Shortfall (CVaR) — average loss beyond VaR.
 * More conservative than VaR as it captures tail risk.
 *
 * CVaR ≈ VaR × (φ(z) / (1 - confidence))
 *
 * @param var_ - Value at Risk
 * @param confidence - Confidence level used for VaR
 */
export function calculateCVaR(var_: number, confidence: number = 0.95): number {
  // ES/CVaR is typically 1.1-1.5x VaR for normal distributions
  const multiplier = 1 / (1 - confidence);
  const pdf_at_z = 0.3989 * Math.exp(-0.5 * Math.pow(1.6449, 2)); // approx for 95%
  return var_ * pdf_at_z * multiplier / 1.6449;
}

/**
 * Kelly Criterion — optimal fraction of capital to risk on a trade.
 * Kelly% = (W × R - L) / R
 * where W = win probability, R = avg win/avg loss ratio, L = loss probability
 *
 * @param winProbability - Probability of winning (0-1)
 * @param avgWin - Average winning amount
 * @param avgLoss - Average losing amount (positive number)
 * @returns Optimal fraction of capital to allocate (0-1)
 */
export function kellyFraction(
  winProbability: number,
  avgWin: number,
  avgLoss: number
): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0;
  if (winProbability <= 0 || winProbability >= 1) return 0;

  const lossProbability = 1 - winProbability;
  const kelly = (winProbability * avgWin - lossProbability * avgLoss) / avgWin;

  // Half-Kelly is common practice for more conservative sizing
  return Math.max(0, Math.min(kelly, 1));
}

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
