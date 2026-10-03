/**
 * Payoff, breakeven, POP and position-sizing tests with hand-computed values.
 */
import { describe, it, expect } from 'vitest';
import { analyzeExpiryPayoff, calculatePayoffAtExpiry, type StrategyLeg } from '../engine/payoff.js';
import { probabilityOfProfitFromLegs, optimalPositionSize } from '../engine/risk-metrics.js';
import { normCDF } from '../utils/math.js';

const L = (type: 'CE' | 'PE', strike: number, action: 'BUY' | 'SELL', premium: number, qty = 1): StrategyLeg =>
  ({ type, strike, action, premium, qty, expiry: '' });

describe('expiry payoff — exact extremes and breakevens', () => {
  it('naked short call has UNLIMITED loss (regression: was reported as −₹2,55,000)', () => {
    const r = analyzeExpiryPayoff([L('CE', 24000, 'SELL', 200)], 75);
    expect(r.maxLoss).toBe(-Infinity);
    expect(r.maxProfit).toBe(15000);
    expect(r.breakevens).toEqual([24200]);
    const grid = calculatePayoffAtExpiry([L('CE', 24000, 'SELL', 200)], { min: 20400, max: 27600, steps: 100 }, 75);
    expect(grid.maxLoss).toBe(-Infinity);
  });

  it('short put loss is BOUNDED at S = 0 (regression: was reported unlimited)', () => {
    const r = analyzeExpiryPayoff([L('PE', 24000, 'SELL', 200)], 75);
    expect(r.maxLoss).toBe(-(24000 - 200) * 75);
    expect(r.breakevens).toEqual([23800]);
  });

  it('long call: unlimited profit, loss = premium', () => {
    const r = analyzeExpiryPayoff([L('CE', 100, 'BUY', 5)], 10);
    expect(r.maxProfit).toBe(Infinity);
    expect(r.maxLoss).toBe(-50);
    expect(r.breakevens).toEqual([105]);
  });

  it('iron condor: hand-computed max profit, max loss, breakevens', () => {
    // Sell 23800 PE @60, buy 23600 PE @30, sell 24200 CE @55, buy 24400 CE @25, lot 75
    const legs = [L('PE', 23800, 'SELL', 60), L('PE', 23600, 'BUY', 30), L('CE', 24200, 'SELL', 55), L('CE', 24400, 'BUY', 25)];
    const credit = 60 - 30 + 55 - 25; // 60
    const r = analyzeExpiryPayoff(legs, 75);
    expect(r.maxProfit).toBe(credit * 75);
    expect(r.maxLoss).toBe(-(200 - credit) * 75);
    expect(r.breakevens).toEqual([23800 - credit, 24200 + credit]);
  });

  it('short straddle: unlimited loss upside, two breakevens', () => {
    const r = analyzeExpiryPayoff([L('CE', 24000, 'SELL', 150), L('PE', 24000, 'SELL', 140)], 75);
    expect(r.maxLoss).toBe(-Infinity);
    expect(r.breakevens).toEqual([23710, 24290]);
  });

  it('cost offset shifts breakevens and reduces max profit (NET payoff)', () => {
    const legs = [L('CE', 24000, 'BUY', 100), L('CE', 24200, 'SELL', 40)];
    const gross = analyzeExpiryPayoff(legs, 75);
    const net = analyzeExpiryPayoff(legs, 75, -150);
    expect(gross.maxProfit).toBe(140 * 75);
    expect(net.maxProfit).toBe(140 * 75 - 150);
    expect(net.maxLoss).toBe(-60 * 75 - 150);
    expect(net.breakevens[0]).toBeCloseTo(24060 + 2, 6);
  });

  it('ratio spread with net long calls upside is unlimited profit', () => {
    const r = analyzeExpiryPayoff([L('CE', 24000, 'SELL', 150), L('CE', 24200, 'BUY', 60, 2)], 75);
    expect(r.maxProfit).toBe(Infinity);
    expect(Number.isFinite(r.maxLoss)).toBe(true);
  });
});

describe('probability of profit from actual payoff', () => {
  const S = 24000, iv = 0.15, T = 30 / 365;
  const sig = iv * Math.sqrt(T);
  const cdf = (x: number) => normCDF((Math.log(x / S) + sig * sig / 2) / sig);

  it('long call POP = P(S_T > K + premium)', () => {
    const p = probabilityOfProfitFromLegs([{ type: 'CE', strike: 24000, premium: 300, qty: 1, action: 'BUY' }], 75, S, iv, T);
    expect(p).toBeCloseTo(1 - cdf(24300), 6);
  });

  it('debit butterfly POP is the probability BETWEEN breakevens (regression: label-based method gave 89.5%)', () => {
    const legs = [
      { type: 'CE' as const, strike: 23900, premium: 330, qty: 1, action: 'BUY' as const },
      { type: 'CE' as const, strike: 24000, premium: 270, qty: 2, action: 'SELL' as const },
      { type: 'CE' as const, strike: 24100, premium: 220, qty: 1, action: 'BUY' as const },
    ];
    // debit = 330 + 220 − 540 = 10 → BEs 23910 and 24090
    const p = probabilityOfProfitFromLegs(legs, 75, S, iv, T);
    expect(p).toBeCloseTo(cdf(24090) - cdf(23910), 6);
    expect(p).toBeLessThan(0.3);
  });

  it('costs reduce POP', () => {
    const legs = [{ type: 'CE' as const, strike: 24000, premium: 300, qty: 1, action: 'BUY' as const }];
    expect(probabilityOfProfitFromLegs(legs, 75, S, iv, T, 500)).toBeLessThan(probabilityOfProfitFromLegs(legs, 75, S, iv, T, 0));
  });

  it('rejects degenerate inputs', () => {
    expect(() => probabilityOfProfitFromLegs([], 75, S, iv, T)).toThrow();
    expect(() => probabilityOfProfitFromLegs([{ type: 'CE', strike: 1, premium: 1, qty: 1, action: 'BUY' }], 75, S, 0, T)).toThrow();
  });
});

describe('position sizing', () => {
  it('uses per-lot rupee loss directly (regression: was multiplied by lot size → 0 lots)', () => {
    const r = optimalPositionSize(100_000, 2, 500);
    expect(r.lots).toBe(4);
    expect(r.totalRisk).toBe(2000);
    expect(optimalPositionSize(100_000, 2, 5000).lots).toBe(0);
  });
  it('rejects unlimited or invalid inputs', () => {
    expect(() => optimalPositionSize(100_000, 2, Infinity)).toThrow();
    expect(() => optimalPositionSize(0, 2, 100)).toThrow();
    expect(() => optimalPositionSize(100_000, 150, 100)).toThrow();
    expect(() => optimalPositionSize(100_000, 2, -5)).toThrow();
  });
});
