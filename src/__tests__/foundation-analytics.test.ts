/**
 * Margin, tail-loss, regime and spread-calibration analytics on hand-checkable inputs.
 */
import { describe, it, expect } from 'vitest';
import type { BacktestTrade } from '../backtest/eod-engine.js';
import { tradeMargin, capitalSummary, maxDrawdown } from '../analytics/margin.js';
import { settlementOutcome, theoreticalMaxNetLoss, tailSummary, varEs } from '../analytics/tail-loss.js';
import { realizedVol, labelTrade, bucketize, REGIME_THRESHOLDS } from '../analytics/regime.js';
import { calibrate, CALIBRATION_RULE } from '../analytics/spread-calibration.js';
import type { QuoteSnapshotRow } from '../history/quote-recorder.js';

function condor(net: number, settle: Record<string, number> = {}): BacktestTrade {
  const leg = (type: 'CE' | 'PE', strike: number, side: 'BUY' | 'SELL', close: number) => ({
    type, strike, side, lots: 1, close, fillPrice: close, lotSize: 65, quantity: 65, settlementValuePerUnit: settle[`${strike}${type}`] ?? 0,
  });
  return {
    id: 'T', signalDate: '2026-09-22', entryDate: '2026-09-23', expiry: '2026-09-29', symbol: 'NIFTY', reason: '', settlementPrice: 0,
    legs: [leg('PE', 24250, 'BUY', 5), leg('PE', 24500, 'SELL', 12), leg('CE', 25500, 'SELL', 10), leg('CE', 25750, 'BUY', 4)],
    pnl: { netPnL: net, totalCosts: 100, slippage: 0 } as BacktestTrade['pnl'], legPnL: [],
  };
}

describe('margin', () => {
  it('max-loss and SPAN proxy for a 250-wide condor', () => {
    const m = tradeMargin(condor(500), ['2026-09-23', '2026-09-24', '2026-09-29'], 25000);
    expect(m.maxLoss).toBe(250 * 65);
    expect(m.spanProxy).toBe(250 * 65 + 0.02 * 25000 * 65);
    expect(m.creditAtFill).toBe((12 + 10 - 5 - 4) * 65);
    expect(m.daysBlocked).toBe(3);
  });
  it('drawdown and sustaining capital', () => {
    expect(maxDrawdown([100, -300, 50, -100, 400])).toBe(350);
    const m = tradeMargin(condor(-1000), ['2026-09-23', '2026-09-29'], 25000);
    const s = capitalSummary([m, { ...m, netPnL: -500 }], ['2026-09-23', '2026-09-29'], '2026-09-23', '2026-09-29');
    expect(s.maxDrawdown).toBe(1500);
    expect(s.sustainingCapital).toBe(2 * m.spanProxy + 1500); // two positions open at once
    expect(s.maxConcurrentPositions).toBe(2);
  });
});

describe('tail loss', () => {
  it('classifies settlement outcomes', () => {
    expect(settlementOutcome(condor(1))).toBe('ALL_OTM');
    expect(settlementOutcome(condor(1, { '25500CE': 100 }))).toBe('SHORT_BREACHED');
    expect(settlementOutcome(condor(1, { '25500CE': 300, '25750CE': 50 }))).toBe('WING_FULLY_BREACHED');
  });
  it('theoretical max net loss = width × qty − credit + costs', () => {
    expect(theoreticalMaxNetLoss(condor(0))).toBe(250 * 65 - 13 * 65 + 100);
  });
  it('empirical VaR / ES', () => {
    const nets = Array.from({ length: 100 }, (_, i) => (i < 5 ? -1000 * (i + 1) : 100));
    expect(varEs(nets, 0.95)).toEqual({ var: 1000, es: 3000 });
    expect(varEs(nets, 0.99)).toEqual({ var: 5000, es: 5000 });
  });
  it('summary: shares, streaks, exclusions', () => {
    const rows = [100, -500, -200, 300, -1000].map((n, i) => ({ tradeId: `t${i}`, netPnL: n, outcome: 'ALL_OTM' as const, worstEodMtm: n - 50, theoreticalMaxNetLoss: 1000, underlyingMove: 0.01 }));
    const s = tailSummary(rows);
    expect(s.totalNet).toBe(-1300);
    expect(s.maxConsecutiveLosses).toBe(2);
    expect(s.netExcludingWorst['1']).toBe(-300);
    expect(s.realizedWorstVsTheoretical).toBe(1);
    expect(s.winsNeededToRepayWorst).toBe(5);
  });
});

describe('regime', () => {
  it('realized vol of a constant-return series is ~0 and needs a full lookback', () => {
    const c = Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i);
    expect(realizedVol(c, 25, 20)).toBeCloseTo(0, 10);
    expect(realizedVol(c, 10, 20)).toBeNull();
  });
  it('labels use only data up to the signal date (ex-ante) and the holding period (ex-post)', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const closes = dates.map((_, i) => (i < 25 ? 100 * 1.002 ** i : 100 * 1.002 ** 24 * 1.05));
    const t = { tradeId: 'x', signalDate: dates[24], entryDate: dates[25], expiry: dates[27], netPnL: -5, isMonthlyExpiry: false, period: 'DEVELOPMENT' as const };
    const l = labelTrade(t, dates, closes);
    expect(l.vol).toBe('LOW_VOL');          // the jump on day 25 is after the signal: not seen
    expect(l.trend).toBe('UP');             // 1.002^20 − 1 ≈ +4.1 % > +3 %
    expect(l.largeMoveInHolding).toBe('NO_LARGE_MOVE'); // the jump lands on entry day itself (day 25), not after entry
    expect(bucketize([t], [l]).find((b) => b.regime === 'vol')).toMatchObject({ trades: 1, sufficient: false });
    expect(REGIME_THRESHOLDS.declared).toBe('2026-10-04');
  });
});

describe('spread calibration', () => {
  const q = (at: string, bid: number, ask: number): QuoteSnapshotRow => ({
    recordedAt: at, sourceAsOf: null, quality: 'FULL', source: 'x', symbol: 'NIFTY', expiry: '2026-10-06', spot: 25000,
    strike: 25500, type: 'CE', bid, ask, bidQty: 1, askQty: 1, ltp: null, iv: null, oi: null, volume: null,
  });
  it('is not ready without enough sessions and uses only the 15:00–15:30 IST window', () => {
    const rows = [q('2026-10-05T09:35:00Z', 10, 10.4), q('2026-10-05T04:00:00Z', 10, 12), q('2026-10-05T09:40:00Z', 0, 1)];
    const r = calibrate(rows, { expiryDaySessions: 0, bigMoveSessions: 0 });
    expect(r.quotesInWindow).toBe(1);   // 15:05 IST; the 09:30 IST quote is outside; zero bid rejected
    expect(r.quotesRejected).toBe(1);
    expect(r.ready).toBe(false);
    expect(r.reasonsNotReady.join(' ')).toMatch(/20 required/);
    expect(r.buckets.find((b) => b.quotes === 1)?.medianHalfSpread).toBe(0.2);
    expect(CALIBRATION_RULE.percentile).toBe(0.75);
  });
});

describe('close-vs-quote gap', async () => {
  const { closeGapObservations, summarizeGaps } = await import('../analytics/close-gap.js');
  const quote = (at: string, strike: number, bid: number, ask: number): QuoteSnapshotRow => ({
    recordedAt: at, sourceAsOf: null, quality: 'FULL', source: 'x', symbol: 'NIFTY', expiry: '2026-10-06', spot: 25000,
    strike, type: 'CE', bid, ask, bidQty: 1, askQty: 1, ltp: null, iv: null, oi: null, volume: null,
  });
  const bhav = (strike: number, close: number, vol = 10) => ({
    tradeDate: '2026-10-05', symbol: 'NIFTY', instrumentType: 'IDX_OPT' as const, expiry: '2026-10-06', strike, optionType: 'CE' as const,
    open: close, high: close, low: close, close, lastPrice: close, previousClose: close, settlementPrice: close, underlyingPrice: 25000,
    openInterest: 1, changeInOpenInterest: 0, volumeContracts: vol, notionalTurnover: 0, trades: 1, lotSize: 65,
  });
  it('uses the LAST snapshot in 15:20–15:30 IST and measures ask − close and close − bid', () => {
    const quotes = [
      quote('2026-10-05T09:50:00Z', 25500, 9, 11),     // 15:20 IST: superseded
      quote('2026-10-05T09:59:00Z', 25500, 9.8, 10.4), // 15:29 IST: used
      quote('2026-10-05T10:05:00Z', 25500, 1, 100),    // 15:35 IST: outside the window
      quote('2026-10-05T09:59:00Z', 25750, 3, 3.5),    // close untraded → excluded
    ];
    const obs = closeGapObservations(quotes, [bhav(25500, 10), bhav(25750, 3.2, 0)]);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ quotedAtIst: '15:29:00', close: 10, buyCost: 0.4, sellCost: 0.2, modelHalfSpread: 0.2 });
    const b = summarizeGaps(obs).find((x) => x.n === 1)!;
    expect(b.modelCoversBoth).toBe(0);   // V1 (₹0.20) under-charges the ₹0.40 buy cost here
    expect(b.closeInsideQuote).toBe(1);
  });
});
