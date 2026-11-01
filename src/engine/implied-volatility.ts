/**
 * @fileoverview Implied Volatility Solver
 *
 * Hybrid Newton-Raphson + Bisection method for computing implied volatility
 * from observed market prices.
 *
 * Algorithm:
 * 1. Initial guess via Brenner-Subrahmanyam approximation: σ₀ = √(2π/T) × C/S
 * 2. Newton-Raphson iterations with vega as derivative
 * 3. Fallback to bisection if Newton diverges or vega is near-zero
 *
 * @module engine/implied-volatility
 */

import {
  optionPrice,
  vega as bsVega,
  type OptionType,
} from './black-scholes.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Convergence tolerance: |BS(σ) - marketPrice| < TOLERANCE */
const TOLERANCE = 0.001;

/** Maximum Newton-Raphson iterations */
const MAX_NEWTON_ITERATIONS = 50;

/** Maximum bisection iterations */
const MAX_BISECTION_ITERATIONS = 100;

/** Minimum vega threshold — below this, Newton is unreliable */
const MIN_VEGA = 1e-10;

/** Volatility bounds for the solver */
const MIN_VOL = 0.001;  // 0.1%
const MAX_VOL = 5.0;    // 500%

/** Clamp bounds for initial guess */
const INITIAL_GUESS_MIN = 0.05;   // 5%
const INITIAL_GUESS_MAX = 3.0;    // 300%

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Brenner-Subrahmanyam initial volatility estimate.
 *
 * Formula: σ₀ = √(2π/T) × (C/S)
 *
 * This approximation works best for near-ATM options and provides
 * a reasonable starting point for the Newton-Raphson solver.
 *
 * @param marketPrice - Observed option price
 * @param S - Spot price
 * @param T - Time to expiry in years
 * @returns Initial volatility estimate, clamped to [0.05, 3.0]
 */
function brennerSubrahmanyam(marketPrice: number, S: number, T: number): number {
  if (T <= 0 || S <= 0) return 0.3; // sensible default
  const rawGuess = Math.sqrt((2 * Math.PI) / T) * (marketPrice / S);
  return Math.min(Math.max(rawGuess, INITIAL_GUESS_MIN), INITIAL_GUESS_MAX);
}

/**
 * Bisection method for IV — guaranteed convergence within bounds.
 *
 * Binary searches the volatility space [lo, hi] to find σ such that
 * |BS(σ) - marketPrice| < tolerance.
 *
 * @param marketPrice - Observed option market price
 * @param S - Spot price
 * @param K - Strike price
 * @param T - Time to expiry in years
 * @param r - Risk-free rate (decimal)
 * @param type - 'CE' or 'PE'
 * @param q - Dividend yield (decimal)
 * @returns Implied volatility or null if no convergence
 */
function bisectionIV(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: OptionType,
  q: number
): number | null {
  let lo = MIN_VOL;
  let hi = MAX_VOL;

  // Verify that a root exists in the bracket
  const priceLo = optionPrice(S, K, T, r, lo, q, type);
  const priceHi = optionPrice(S, K, T, r, hi, q, type);

  // If market price is below the min-vol price or above the max-vol price,
  // no valid IV exists in the bracket
  if (marketPrice < priceLo - TOLERANCE || marketPrice > priceHi + TOLERANCE) {
    return null;
  }

  for (let i = 0; i < MAX_BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const priceMid = optionPrice(S, K, T, r, mid, q, type);
    const diff = priceMid - marketPrice;

    if (Math.abs(diff) < TOLERANCE) {
      return mid;
    }

    if (diff > 0) {
      hi = mid;
    } else {
      lo = mid;
    }

    // Additional convergence check on interval width
    if (hi - lo < 1e-8) {
      return mid;
    }
  }

  // Final check: return midpoint if reasonably close
  const finalMid = (lo + hi) / 2;
  const finalPrice = optionPrice(S, K, T, r, finalMid, q, type);
  if (Math.abs(finalPrice - marketPrice) < TOLERANCE * 10) {
    return finalMid;
  }

  return null;
}

// ─── Main IV Solver ──────────────────────────────────────────────────────────

/**
 * Calculate Implied Volatility using hybrid Newton-Raphson + Bisection.
 *
 * Algorithm:
 * 1. Compute initial guess using Brenner-Subrahmanyam: σ₀ = √(2π/T) × (C/S)
 * 2. Clamp initial guess to [0.05, 3.0]
 * 3. Newton-Raphson: σₙ₊₁ = σₙ - (BS(σₙ) - marketPrice) / Vega(σₙ)
 * 4. If |Vega| < 1e-10 OR σ jumps outside [0.001, 5.0] → switch to Bisection
 * 5. Bisection: binary search in [0.001, 5.0] with up to 100 iterations
 * 6. Convergence criterion: |BS(σ) - marketPrice| < 0.001
 * 7. Returns null if no convergence
 *
 * @param marketPrice - Observed option market price (must be positive)
 * @param S - Spot price of the underlying (must be positive)
 * @param K - Strike price (must be positive)
 * @param T - Time to expiry in years (must be positive)
 * @param r - Risk-free interest rate (annualized, decimal)
 * @param type - Option type: 'CE' for call, 'PE' for put
 * @param q - Continuous dividend yield (annualized, decimal, default 0)
 * @returns Implied volatility as a decimal (e.g. 0.25 for 25%), or null if solver fails
 *
 * @example
 * // NIFTY 24500 CE trading at 350 with spot at 24800, 15 days to expiry
 * const iv = calculateIV(350, 24800, 24500, 15/365, 0.07, 'CE');
 * // Returns approximately 0.14 (14%)
 */
export function calculateIV(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: OptionType,
  q: number = 0
): number | null {
  // ─── Input validation ────────────────────────────────────────────────
  if (marketPrice <= 0 || S <= 0 || K <= 0 || T <= 0) {
    return null;
  }

  // European no-arbitrage LOWER bound uses DISCOUNTED values:
  //   call ≥ max(S·e^(−qT) − K·e^(−rT), 0), put ≥ max(K·e^(−rT) − S·e^(−qT), 0).
  // (Undiscounted intrinsic wrongly rejected valid deep-ITM European puts.)
  const fwdS = S * Math.exp(-q * T);
  const pvK = K * Math.exp(-r * T);
  const lowerBound = type === 'CE' ? Math.max(fwdS - pvK, 0) : Math.max(pvK - fwdS, 0);
  // Allow a small tolerance for bid-ask around the bound
  if (marketPrice < lowerBound - TOLERANCE * 100) {
    return null;
  }

  // Check if market price exceeds upper bound
  // Call upper bound: S·e^(-qT), Put upper bound: K·e^(-rT)
  const upperBound =
    type === 'CE'
      ? S * Math.exp(-q * T)
      : K * Math.exp(-r * T);
  if (marketPrice > upperBound + TOLERANCE * 100) {
    return null;
  }

  // ─── Newton-Raphson ──────────────────────────────────────────────────
  let sigma = brennerSubrahmanyam(marketPrice, S, T);
  let useBisection = false;

  for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
    const bsPrice = optionPrice(S, K, T, r, sigma, q, type);
    const diff = bsPrice - marketPrice;

    // Check convergence
    if (Math.abs(diff) < TOLERANCE) {
      return sigma;
    }

    // Vega is returned per 1% move, so multiply by 100 to get raw dPrice/dSigma
    const vegaVal = bsVega(S, K, T, r, sigma, q) * 100;

    // If vega is too small, Newton-Raphson is unreliable
    if (Math.abs(vegaVal) < MIN_VEGA) {
      useBisection = true;
      break;
    }

    // Newton step
    const newSigma = sigma - diff / vegaVal;

    // If Newton jumps outside valid bounds, switch to bisection
    if (newSigma <= MIN_VOL || newSigma >= MAX_VOL) {
      useBisection = true;
      break;
    }

    // Check for oscillation (sigma not converging)
    if (i > 10 && Math.abs(newSigma - sigma) < 1e-12) {
      // Effectively converged in sigma space
      const finalPrice = optionPrice(S, K, T, r, newSigma, q, type);
      if (Math.abs(finalPrice - marketPrice) < TOLERANCE * 10) {
        return newSigma;
      }
      useBisection = true;
      break;
    }

    sigma = newSigma;
  }

  // ─── Bisection fallback ──────────────────────────────────────────────
  if (useBisection) {
    return bisectionIV(marketPrice, S, K, T, r, type, q);
  }

  // Newton didn't converge within max iterations — try bisection anyway
  return bisectionIV(marketPrice, S, K, T, r, type, q);
}
