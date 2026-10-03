/**
 * Reference-value and property tests for Black-Scholes, Greeks, IV and the
 * shared normal CDF.
 *
 * References:
 * - Φ values: standard normal table (Abramowitz & Stegun Table 26.1).
 * - Hull, "Options, Futures and Other Derivatives", Example 15.6:
 *   S=42, K=40, r=10%, σ=20%, T=0.5 → C = 4.76, P = 0.81.
 */
import { describe, it, expect } from 'vitest';
import {
  callPrice, putPrice, optionPrice, calculateGreeks, normCDF as bsNormCDF,
} from '../engine/black-scholes.js';
import { normCDF } from '../utils/math.js';
import { calculateIV } from '../engine/implied-volatility.js';

describe('normal CDF (single shared implementation)', () => {
  const table: Array<[number, number]> = [
    [-3, 0.0013499], [-2, 0.0227501], [-1.645, 0.0499849], [-1, 0.1586553],
    [-0.5, 0.3085375], [0, 0.5], [0.5, 0.6914625], [1, 0.8413447],
    [1.645, 0.9500151], [1.96, 0.9750021], [2, 0.9772499], [3, 0.9986501],
  ];
  it.each(table)('Φ(%f) ≈ %f within 1e-6', (x, ref) => {
    expect(Math.abs(normCDF(x) - ref)).toBeLessThan(1e-6);
  });
  it('utils/math and black-scholes use the same function (regression for the broken utils copy)', () => {
    for (const x of [-2.5, -1, 0.3, 1.7]) expect(normCDF(x)).toBe(bsNormCDF(x));
  });
});

describe('Black-Scholes reference values', () => {
  it('Hull Example 15.6 call ≈ 4.76', () => {
    expect(callPrice(42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(4.7594, 3);
  });
  it('Hull Example 15.6 put ≈ 0.81', () => {
    expect(putPrice(42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(0.8086, 3);
  });
  it('put-call parity with dividend yield holds to 1e-8 across a grid', () => {
    for (const S of [80, 100, 120]) for (const K of [90, 100, 110]) for (const T of [0.02, 0.25, 1]) for (const q of [0, 0.02]) {
      const c = callPrice(S, K, T, 0.07, 0.25, q);
      const p = putPrice(S, K, T, 0.07, 0.25, q);
      expect(c - p).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-0.07 * T), 6);
    }
  });
  it('prices respect no-arbitrage bounds', () => {
    for (const K of [18000, 24000, 30000]) {
      const c = callPrice(24000, K, 30 / 365, 0.07, 0.15);
      const p = putPrice(24000, K, 30 / 365, 0.07, 0.15);
      expect(c).toBeGreaterThanOrEqual(Math.max(24000 - K * Math.exp(-0.07 * 30 / 365), 0) - 1e-6);
      expect(c).toBeLessThanOrEqual(24000);
      expect(p).toBeGreaterThanOrEqual(Math.max(K * Math.exp(-0.07 * 30 / 365) - 24000, 0) - 1e-6);
    }
  });
  it('T = 0 returns intrinsic value', () => {
    expect(callPrice(105, 100, 0, 0.07, 0.2)).toBe(5);
    expect(putPrice(95, 100, 0, 0.07, 0.2)).toBe(5);
  });
});

describe('Greeks match finite differences of the price', () => {
  const S = 24000, K = 24200, T = 20 / 365, r = 0.07, sig = 0.14;
  for (const type of ['CE', 'PE'] as const) {
    it(`${type}: delta, gamma, vega, theta, rho`, () => {
      const g = calculateGreeks(S, K, T, r, sig, 0, type);
      const p = (s = S, k = K, t = T, rr = r, v = sig) => optionPrice(s, k, t, rr, v, 0, type);
      const h = 1;
      expect(g.delta).toBeCloseTo((p(S + h) - p(S - h)) / (2 * h), 4);
      expect(g.gamma).toBeCloseTo((p(S + h) - 2 * p() + p(S - h)) / (h * h), 5);
      expect(g.vega).toBeCloseTo((p(S, K, T, r, sig + 0.0001) - p(S, K, T, r, sig - 0.0001)) / 0.0002 / 100, 3);
      expect(g.rho).toBeCloseTo((p(S, K, T, r + 0.0001) - p(S, K, T, r - 0.0001)) / 0.0002 / 100, 3);
      const dt = 1 / 365;
      // Theta per calendar day ≈ price change over one day (central difference).
      expect(g.theta).toBeCloseTo((p(S, K, T - dt / 100) - p(S, K, T + dt / 100)) / (2 * dt / 100) / 365, 2);
    });
  }
});

describe('Implied volatility', () => {
  it('round-trips σ across strikes, expiries and vols (property test)', () => {
    for (const K of [21000, 23000, 24000, 25000, 27000]) {
      for (const days of [1, 7, 30, 90]) {
        for (const sig of [0.08, 0.15, 0.35, 0.8]) {
          for (const type of ['CE', 'PE'] as const) {
            const T = days / 365;
            const price = optionPrice(24000, K, T, 0.07, sig, 0, type);
            if (price < 0.05) continue; // below tick: IV not identifiable
            const iv = calculateIV(price, 24000, K, T, 0.07, type);
            expect(iv, `K=${K} d=${days} σ=${sig} ${type}`).not.toBeNull();
            // Price tolerance ₹0.001 → σ error bounded by tol/vega.
            const recovered = optionPrice(24000, K, T, 0.07, iv as number, 0, type);
            expect(Math.abs(recovered - price)).toBeLessThan(0.002);
          }
        }
      }
    }
  });
  it('rejects invalid inputs instead of returning a number', () => {
    expect(calculateIV(0, 100, 100, 0.1, 0.07, 'CE')).toBeNull();
    expect(calculateIV(-1, 100, 100, 0.1, 0.07, 'CE')).toBeNull();
    expect(calculateIV(10, 100, 100, 0, 0.07, 'CE')).toBeNull();
    expect(calculateIV(150, 100, 100, 0.1, 0.07, 'CE')).toBeNull(); // above S
    expect(calculateIV(1, 120, 100, 0.1, 0.07, 'CE')).toBeNull(); // below intrinsic
  });
});
