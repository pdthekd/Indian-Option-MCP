/**
 * @module utils/math
 * Statistical and mathematical utilities for options analytics.
 */

/**
 * Standard normal PDF and CDF.
 *
 * Re-exported from the Black-Scholes engine so the codebase has ONE
 * implementation (A&S 26.2.17, |error| < 7.5e-8). The previous local copy
 * applied erf (A&S 7.1.26) coefficients to x instead of x/√2, giving
 * Φ(1) = 0.870 instead of 0.841, which corrupted probability of profit.
 */
export { normPDF, normCDF } from '../engine/black-scholes.js';

/**
 * Arithmetic mean of an array.
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Sample standard deviation.
 */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map(v => (v - avg) ** 2);
  return Math.sqrt(squaredDiffs.reduce((s, v) => s + v, 0) / (values.length - 1));
}

/**
 * Calculate the p-th percentile of a sorted array (0–100 scale).
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Calculate log returns from a price series.
 */
export function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return returns;
}

/**
 * Find the sign of a number: -1, 0, or 1.
 */
export function sign(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}
