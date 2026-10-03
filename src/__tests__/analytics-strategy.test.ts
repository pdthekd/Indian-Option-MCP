import { describe, it, expect } from 'vitest';
import { computeNetMetrics } from '../analytics/performance.js';
import { costSensitivity, applyScenario, STANDARD_SCENARIOS } from '../analytics/cost-sensitivity.js';
import { StrategyRegistry, fingerprint, type StrategySpec } from '../strategy/strategy-spec.js';
import { PointInTimeGuard, LookAheadError, type HistoricalMarketDataProvider } from '../backtest/historical-data.js';
import type { TradePnL } from '../pnl/pnl-engine.js';

function trade(gross: number, costs: number, i = 0): TradePnL {
  const net = gross - costs;
  return {
    tradeId: `t${i}`, direction: 'LONG', grossEntryValue: 0, grossExitValue: 0, grossPnL: gross,
    brokerage: costs * 0.4, stt: costs * 0.3, exchangeCharges: costs * 0.1, gst: costs * 0.1, sebiCharges: 0,
    stampDuty: costs * 0.05, slippage: costs * 0.05, otherCosts: 0, totalCosts: costs, netPnL: net,
    classification: net > 0 ? 'NET_PROFIT' : net < 0 ? 'NET_LOSS' : 'NET_BREAKEVEN', grossProfitNetLoss: gross > 0 && net <= 0,
    costSource: 'MODEL', scheduleIds: [], assumptions: [],
  };
}

describe('net performance metrics and verdicts', () => {
  it('UNKNOWN below the minimum sample size', () => {
    expect(computeNetMetrics([trade(1000, 100)]).verdict).toBe('UNKNOWN');
  });
  it('gross-positive but net-negative strategy is flagged as such', () => {
    const ts = Array.from({ length: 200 }, (_, i) => trade(i % 2 ? 500 : -300, 150, i)); // gross +100/trade, net −50
    const m = computeNetMetrics(ts);
    expect(m.grossExpectancy).toBe(100);
    expect(m.netExpectancy).toBe(-50);
    expect(m.verdict).toBe('PROFITABLE BEFORE COSTS BUT NOT VALIDATED AFTER COSTS');
  });
  it('drawdown, streak and profit factor on NET P&L', () => {
    const ts = [trade(100, 0), trade(-50, 0), trade(-60, 0), trade(-10, 0), trade(200, 0)];
    const m = computeNetMetrics(ts, { minTrades: 1 });
    expect(m.maxDrawdown).toBe(120);
    expect(m.longestLosingStreak).toBe(3);
    expect(m.profitFactor).toBeCloseTo(300 / 120, 10);
  });
  it('a strategy with higher gross but higher costs ranks lower on net', () => {
    const a = Array.from({ length: 150 }, (_, i) => trade(i % 2 ? 400 : -200, 20, i));
    const b = Array.from({ length: 150 }, (_, i) => trade(i % 2 ? 600 : -200, 230, i));
    const ma = computeNetMetrics(a), mb = computeNetMetrics(b);
    expect(mb.grossExpectancy).toBeGreaterThan(ma.grossExpectancy);
    expect(mb.netExpectancy).toBeLessThan(ma.netExpectancy);
  });
});

describe('cost sensitivity', () => {
  it('heavier scenarios never improve net', () => {
    const t = trade(1000, 300);
    const nets = STANDARD_SCENARIOS.map((s) => applyScenario(t, s).netPnL);
    expect(nets[0]).toBeCloseTo(700, 6);
    expect(nets[1]).toBeLessThan(nets[0]);
    expect(nets[2]).toBeLessThan(nets[1]);
  });
  it('reports break-evens and whether all scenarios survive', () => {
    const ts = Array.from({ length: 200 }, (_, i) => trade(i % 2 ? 300 : -100, 60, i)); // gross +100, costs 60
    const r = costSensitivity(ts);
    expect(r.breakEven.breakEvenCostPerTrade).toBe(100);
    expect(r.breakEven.breakEvenExtraSlippagePerTrade).toBe(40);
    expect(r.survivesAllScenarios).toBe(false); // SEVERE wipes out the edge
  });
});

const baseSpec: StrategySpec = {
  strategyId: 'example_bull_call_spread', version: '0.1.0', status: 'DRAFT',
  description: 'Example only — not a validated strategy.',
  eligibleUnderlyings: ['NIFTY'],
  eligibleExpiries: { minDaysToExpiry: 3, maxDaysToExpiry: 30, weeklyAllowed: true, monthlyAllowed: true },
  structure: { template: 'bull_call_spread', definedRiskOnly: true, legs: [
    { type: 'CE', action: 'BUY', strikeRule: 'ATM', lots: 1 }, { type: 'CE', action: 'SELL', strikeRule: 'ATM+2 strikes', lots: 1 }] },
  entryConditions: ['data quality FULL'], exitConditions: ['T-1 day'], stopRules: ['net loss ≥ 50% of max'],
  profitTakingRules: ['net profit ≥ 50% of max'], invalidationConditions: ['spread > 3%'],
  risk: { maxNetLossPerTradeRupees: 2000, maxLotsPerTrade: 1, maxConcurrentPositions: 1, expectedHoldingTime: '1-5 days' },
  liquidity: { minOpenInterestContracts: 1000, maxBidAskSpreadPct: 0.03, minDataQuality: 'FULL' },
  costAssumptions: { chargeScheduleIds: ['IN-NSE-FO-2026-04-01-r2'], brokeragePlanId: 'ZERODHA-FO-r2', slippageModel: 'SPREAD_FRACTION 0.5' },
  changelog: [{ version: '0.1.0', date: '2026-10-03', change: 'initial draft' }],
};

describe('strategy specs are versioned', () => {
  it('validates and fingerprints deterministically', () => {
    const r = new StrategyRegistry();
    r.register(baseSpec);
    expect(fingerprint(baseSpec)).toBe(fingerprint(JSON.parse(JSON.stringify(baseSpec))));
  });
  it('refuses a silent change without a version bump', () => {
    const r = new StrategyRegistry();
    r.register(baseSpec);
    expect(() => r.register({ ...baseSpec, risk: { ...baseSpec.risk, maxLotsPerTrade: 5 } })).toThrow(/Bump the version/);
  });
  it('rejects undefined-risk structures and unknown fields; there is no LIVE status', () => {
    expect(() => new StrategyRegistry().register({ ...baseSpec, structure: { ...baseSpec.structure, definedRiskOnly: false } })).toThrow();
    expect(() => new StrategyRegistry().register({ ...baseSpec, extra: 1 })).toThrow();
    expect(() => new StrategyRegistry().register({ ...baseSpec, status: 'LIVE' })).toThrow();
  });
});

describe('point-in-time guard', () => {
  const inner: HistoricalMarketDataProvider = {
    name: 'fixture',
    listedExpiries: async () => ['2026-10-06'],
    chainAt: async (u, e, asOf) => ({
      underlying: u, underlyingPrice: 25000, underlyingTimestamp: asOf, expiry: e, lotSize: 65, asOf,
      quotes: [{ symbol: 'X', underlying: u, expiry: e, strike: 25000, optionType: 'CE', bid: 1, ask: 2, ltp: 1.5, volume: 1, openInterest: 1, impliedVolatility: null, timestamp: new Date(asOf.getTime() + 60_000) }],
    }),
    settlementPrice: async () => 25100,
  };
  it('throws on future-stamped data and premature settlement access', async () => {
    const now = new Date('2026-10-05T05:00:00Z');
    const g = new PointInTimeGuard(inner, () => now);
    await expect(g.chainAt('NIFTY', '2026-10-06', now)).rejects.toBeInstanceOf(LookAheadError);
    await expect(g.chainAt('NIFTY', '2026-10-06', new Date(now.getTime() + 1))).rejects.toBeInstanceOf(LookAheadError);
    await expect(g.settlementPrice('NIFTY', '2026-10-06')).rejects.toBeInstanceOf(LookAheadError);
  });
});
