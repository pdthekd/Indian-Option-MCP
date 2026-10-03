/**
 * @fileoverview Option Strategy Payoff Calculator
 *
 * Calculates theoretical P&L at expiry and before expiry for multi-leg
 * option strategies. Supports finding breakeven points and computing
 * risk/reward metrics.
 *
 * @module engine/payoff
 */

import { optionPrice, type OptionType } from './black-scholes.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single leg in an option strategy */
export interface StrategyLeg {
  /** Option type: Call or Put */
  type: OptionType;
  /** Strike price */
  strike: number;
  /** Premium paid/received per unit */
  premium: number;
  /** Number of lots */
  qty: number;
  /** Whether this leg is bought or sold */
  action: 'BUY' | 'SELL';
  /** Expiry date string */
  expiry: string;
}

/** A single data point on the payoff curve */
export interface PayoffPoint {
  /** Hypothetical underlying price at evaluation */
  underlyingPrice: number;
  /** Profit or loss at this price */
  pnl: number;
}

/** Complete payoff analysis result */
export interface PayoffResult {
  /** Array of payoff data points */
  data: PayoffPoint[];
  /** Maximum possible profit (Infinity if unlimited) */
  maxProfit: number;
  /** Maximum possible loss (negative number, -Infinity if unlimited) */
  maxLoss: number;
  /** Breakeven prices where P&L = 0 */
  breakevens: number[];
  /** Risk/reward ratio (|maxProfit / maxLoss|, Infinity if risk is zero) */
  riskRewardRatio: number;
}

/** Spot price range for payoff computation */
export interface SpotRange {
  /** Minimum spot price to evaluate */
  min: number;
  /** Maximum spot price to evaluate */
  max: number;
  /** Number of evaluation steps */
  steps: number;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Compute intrinsic value of a single option at expiry.
 * @param type - 'CE' or 'PE'
 * @param strike - Strike price
 * @param spot - Spot price at expiry
 * @returns Intrinsic value (always ≥ 0)
 */
function intrinsicValue(type: OptionType, strike: number, spot: number): number {
  if (type === 'CE') {
    return Math.max(spot - strike, 0);
  }
  return Math.max(strike - spot, 0);
}

/**
 * Calculate the P&L for a single leg at a given spot price at expiry.
 * @param leg - Strategy leg
 * @param spot - Hypothetical spot price
 * @param lotSize - Lot size
 * @returns P&L for this leg
 */
function legPayoffAtExpiry(
  leg: StrategyLeg,
  spot: number,
  lotSize: number
): number {
  const intrinsic = intrinsicValue(leg.type, leg.strike, spot);
  const direction = leg.action === 'BUY' ? 1 : -1;
  // P&L = direction * (intrinsic - premium) * qty * lotSize
  return direction * (intrinsic - leg.premium) * leg.qty * lotSize;
}

/**
 * Parse an expiry date string and compute days remaining from today.
 */
function daysToExpiry(expiryStr: string): number {
  const expiry = new Date(expiryStr);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max((expiry.getTime() - now.getTime()) / msPerDay, 0.001);
}

// ─── Core Payoff Functions ───────────────────────────────────────────────────

/**
 * Calculate the payoff of a multi-leg strategy at expiry.
 *
 * For each hypothetical spot price in the range, computes the total P&L
 * from all legs using intrinsic value (max(S-K, 0) for CE, max(K-S, 0) for PE).
 *
 * @param legs - Array of strategy legs
 * @param spotRange - Range of spot prices to evaluate
 * @param lotSize - Lot size (e.g. 25 for NIFTY, 15 for BANKNIFTY)
 * @returns Complete payoff analysis
 *
 * @example
 * // Bull Call Spread: Buy 24500 CE at 200, Sell 24700 CE at 100
 * const legs = [
 *   { type: 'CE', strike: 24500, premium: 200, qty: 1, action: 'BUY', expiry: '2025-06-12' },
 *   { type: 'CE', strike: 24700, premium: 100, qty: 1, action: 'SELL', expiry: '2025-06-12' },
 * ];
 * const result = calculatePayoffAtExpiry(legs, { min: 24000, max: 25200, steps: 100 }, 25);
 */
export function calculatePayoffAtExpiry(
  legs: StrategyLeg[],
  spotRange: SpotRange,
  lotSize: number
): PayoffResult {
  if (legs.length === 0) {
    return {
      data: [],
      maxProfit: 0,
      maxLoss: 0,
      breakevens: [],
      riskRewardRatio: 0,
    };
  }

  const { min, max, steps } = spotRange;
  const stepSize = (max - min) / Math.max(steps, 1);
  const data: PayoffPoint[] = [];

  // Also compute at each strike for precision (breakevens near strikes)
  const allPrices = new Set<number>();
  for (let i = 0; i <= steps; i++) {
    allPrices.add(min + i * stepSize);
  }
  // Add exact strike prices for accurate kink detection
  for (const leg of legs) {
    if (leg.strike >= min && leg.strike <= max) {
      allPrices.add(leg.strike);
      // Add points just around the strike for slope detection
      allPrices.add(leg.strike - 0.01);
      allPrices.add(leg.strike + 0.01);
    }
  }

  const sortedPrices = Array.from(allPrices).sort((a, b) => a - b);

  let maxPnl = -Infinity;
  let minPnl = Infinity;

  for (const spotPrice of sortedPrices) {
    let totalPnl = 0;
    for (const leg of legs) {
      totalPnl += legPayoffAtExpiry(leg, spotPrice, lotSize);
    }
    data.push({ underlyingPrice: spotPrice, pnl: totalPnl });
    maxPnl = Math.max(maxPnl, totalPnl);
    minPnl = Math.min(minPnl, totalPnl);
  }

  void maxPnl;
  void minPnl;

  // Expiry payoff is piecewise linear with kinks only at strikes, so its
  // global extremes over S ∈ [0, ∞) are exact: evaluate at S = 0 and every
  // strike, and use the slope beyond the highest strike for the upper tail.
  // (The previous grid-edge heuristic missed unlimited loss on the upside —
  // e.g. a naked short call was reported with a finite max loss — and
  // reported a short put's bounded loss as unlimited.)
  const exact = analyzeExpiryPayoff(legs, lotSize);
  const effectiveMaxProfit = exact.maxProfit;
  const effectiveMaxLoss = exact.maxLoss;
  const breakevens = exact.breakevens;

  const riskRewardRatio =
    effectiveMaxLoss === 0
      ? Infinity
      : effectiveMaxProfit === Infinity || effectiveMaxLoss === -Infinity
        ? Infinity
        : Math.abs(effectiveMaxProfit / effectiveMaxLoss);

  return {
    data,
    maxProfit: effectiveMaxProfit,
    maxLoss: effectiveMaxLoss,
    breakevens,
    riskRewardRatio,
  };
}

/** Exact characteristics of an expiry payoff over S ∈ [0, ∞). */
export interface ExpiryPayoffAnalysis {
  /** Max profit (Infinity if unbounded as S → ∞). */
  maxProfit: number;
  /** Max loss as a negative number (−Infinity if unbounded as S → ∞). */
  maxLoss: number;
  /** Exact breakevens (P&L crosses or touches zero), ascending. */
  breakevens: number[];
  /** dP&L/dS for S above the highest strike. */
  upperTailSlope: number;
  /** P&L at S = 0. */
  pnlAtZero: number;
  /** Kink points used (0 and each distinct strike), ascending. */
  kinks: number[];
}

/** Total expiry P&L of all legs at a single underlying price. */
export function payoffAt(legs: StrategyLeg[], spot: number, lotSize: number, offset = 0): number {
  let total = offset;
  for (const leg of legs) total += legPayoffAtExpiry(leg, spot, lotSize);
  return total;
}

/**
 * Exact analysis of a piecewise-linear expiry payoff.
 *
 * @param offset Constant added to P&L at every price (e.g. −estimated costs),
 *               so breakevens can be computed NET of costs.
 */
export function analyzeExpiryPayoff(
  legs: StrategyLeg[],
  lotSize: number,
  offset = 0,
): ExpiryPayoffAnalysis {
  const kinks = Array.from(new Set([0, ...legs.map((l) => l.strike)]))
    .filter((k) => k >= 0)
    .sort((a, b) => a - b);
  const values = kinks.map((k) => payoffAt(legs, k, lotSize, offset));

  let upperTailSlope = 0;
  for (const leg of legs) {
    if (leg.type === 'CE') upperTailSlope += (leg.action === 'BUY' ? 1 : -1) * leg.qty * lotSize;
  }

  const finiteMax = Math.max(...values);
  const finiteMin = Math.min(...values);
  const EPS = 1e-9;
  const maxProfit = upperTailSlope > EPS ? Infinity : finiteMax;
  const maxLoss = upperTailSlope < -EPS ? -Infinity : finiteMin;

  const bes: number[] = [];
  const pushBE = (x: number) => {
    const r = Math.round(x * 100) / 100;
    if (!bes.some((b) => Math.abs(b - r) < 0.005)) bes.push(r);
  };
  for (let i = 0; i < kinks.length; i++) {
    const v = values[i];
    if (Math.abs(v) < EPS && kinks[i] > 0) pushBE(kinks[i]);
    if (i < kinks.length - 1) {
      const v2 = values[i + 1];
      if ((v < -EPS && v2 > EPS) || (v > EPS && v2 < -EPS)) {
        pushBE(kinks[i] + (-v * (kinks[i + 1] - kinks[i])) / (v2 - v));
      }
    }
  }
  const last = values[values.length - 1];
  const lastK = kinks[kinks.length - 1];
  if ((last < -EPS && upperTailSlope > EPS) || (last > EPS && upperTailSlope < -EPS)) {
    pushBE(lastK - last / upperTailSlope);
  }

  return {
    maxProfit,
    maxLoss,
    breakevens: bes.sort((a, b) => a - b),
    upperTailSlope,
    pnlAtZero: values[0],
    kinks,
  };
}

/**
 * Calculate the payoff of a multi-leg strategy before expiry.
 *
 * Uses Black-Scholes pricing to value each leg at the hypothetical spot price,
 * assuming a uniform IV and constant risk-free rate.
 *
 * @param legs - Array of strategy legs
 * @param spotRange - Range of spot prices to evaluate
 * @param lotSize - Lot size
 * @param daysRemaining - Calendar days remaining to expiry
 * @param iv - Implied volatility (decimal, e.g. 0.15 for 15%)
 * @param r - Risk-free rate (decimal, e.g. 0.07 for 7%)
 * @returns Complete payoff analysis
 */
export function calculatePayoffBeforeExpiry(
  legs: StrategyLeg[],
  spotRange: SpotRange,
  lotSize: number,
  daysRemaining: number,
  iv: number,
  r: number
): PayoffResult {
  if (legs.length === 0) {
    return {
      data: [],
      maxProfit: 0,
      maxLoss: 0,
      breakevens: [],
      riskRewardRatio: 0,
    };
  }

  const T = Math.max(daysRemaining / 365, 1e-6);
  const { min, max, steps } = spotRange;
  const stepSize = (max - min) / Math.max(steps, 1);
  const data: PayoffPoint[] = [];

  let maxPnl = -Infinity;
  let minPnl = Infinity;

  for (let i = 0; i <= steps; i++) {
    const spotPrice = min + i * stepSize;
    let totalPnl = 0;

    for (const leg of legs) {
      // Current theoretical price at this hypothetical spot
      const theoreticalPrice = optionPrice(
        spotPrice,
        leg.strike,
        T,
        r,
        iv,
        0,
        leg.type
      );

      const direction = leg.action === 'BUY' ? 1 : -1;
      // P&L = direction * (theoretical - entry_premium) * qty * lotSize
      const legPnl = direction * (theoreticalPrice - leg.premium) * leg.qty * lotSize;
      totalPnl += legPnl;
    }

    data.push({ underlyingPrice: spotPrice, pnl: totalPnl });
    maxPnl = Math.max(maxPnl, totalPnl);
    minPnl = Math.min(minPnl, totalPnl);
  }

  const breakevens = findBreakevens(data);

  const riskRewardRatio =
    minPnl === 0
      ? Infinity
      : Math.abs(maxPnl / minPnl);

  return {
    data,
    maxProfit: maxPnl,
    maxLoss: minPnl,
    breakevens,
    riskRewardRatio,
  };
}

/**
 * Find breakeven points where P&L crosses zero.
 *
 * Uses linear interpolation between adjacent data points where the
 * sign of P&L changes.
 *
 * @param dataPoints - Sorted array of payoff data points
 * @returns Array of breakeven underlying prices
 */
export function findBreakevens(dataPoints: PayoffPoint[]): number[] {
  if (dataPoints.length < 2) return [];

  const breakevens: number[] = [];

  for (let i = 0; i < dataPoints.length - 1; i++) {
    const curr = dataPoints[i];
    const next = dataPoints[i + 1];

    // Check for sign change (zero crossing)
    if (
      (curr.pnl >= 0 && next.pnl < 0) ||
      (curr.pnl < 0 && next.pnl >= 0) ||
      (curr.pnl <= 0 && next.pnl > 0) ||
      (curr.pnl > 0 && next.pnl <= 0)
    ) {
      // Exact zero
      if (curr.pnl === 0) {
        breakevens.push(curr.underlyingPrice);
        continue;
      }
      if (next.pnl === 0) {
        // Will be picked up in the next iteration or as curr
        continue;
      }

      // Linear interpolation: find x where y = 0
      // x = x1 + (0 - y1) * (x2 - x1) / (y2 - y1)
      const x =
        curr.underlyingPrice +
        (0 - curr.pnl) *
          (next.underlyingPrice - curr.underlyingPrice) /
          (next.pnl - curr.pnl);
      breakevens.push(Math.round(x * 100) / 100); // Round to 2 decimal places
    }
  }

  // Check last point
  const last = dataPoints[dataPoints.length - 1];
  if (last.pnl === 0) {
    breakevens.push(last.underlyingPrice);
  }

  // Remove duplicates and sort
  const unique = Array.from(new Set(breakevens.map(b => Math.round(b * 100) / 100)));
  return unique.sort((a, b) => a - b);
}
