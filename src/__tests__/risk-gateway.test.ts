import { describe, it, expect } from 'vitest';
import { evaluateRisk, CONSERVATIVE_DEFAULT_LIMITS as L, type RiskContext, type RiskProposal, type ProposedLeg } from '../risk/risk-gateway.js';
import type { AccountSnapshot, InstrumentSpec, Order } from '../broker/types.js';

// A defined-risk bear call spread that passes every check; each test changes ONE input.
const NOW = new Date('2026-10-06T06:00:00Z');
const spec = (strike: number): InstrumentSpec => ({
  symbol: `NIFTY26OCT${strike}CE`, kind: 'OPTION', underlying: 'INDEX', lotSize: 75, tickSize: 0.05,
  expiry: '2026-10-13', strike, optionType: 'CE', underlyingSymbol: 'NIFTY',
});
const leg = (strike: number, side: 'BUY' | 'SELL'): ProposedLeg => ({
  spec: spec(strike), side, quantity: 75, orderType: 'MARKET', referencePrice: 100.5,
  expectedFillPrice: side === 'BUY' ? 101 : 100,
  quote: { symbol: spec(strike).symbol, bid: 100, ask: 101, bidQty: 750, askQty: 750, ltp: 100.5, timestamp: new Date(NOW.getTime() - 1000) },
});
const proposal = (o: Partial<RiskProposal> = {}): RiskProposal => ({
  strategyId: 'S', strategyVersion: '1', legs: [leg(25000, 'SELL'), leg(25100, 'BUY')],
  estimatedMaxNetLoss: 1000, estimatedTotalCosts: 100, estimatedMargin: 5000, ...o,
});
const account = (o: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  mode: 'paper', initialCapital: 100_000, cash: 100_000, marginBlocked: 0, availableFunds: 100_000, realizedGrossPnL: 0,
  unrealizedGrossPnL: 0, totalChargesPaid: 0, netPnL: 0, netLiquidationPnLEstimate: 0, equity: 100_000, peakEquity: 100_000,
  maxDrawdown: 0, maxDrawdownPct: 0, dayStartEquity: 100_000, dailyNetPnL: 0, weekStartEquity: 100_000, weeklyNetPnL: 0,
  closedTrades: [], asOf: NOW.toISOString(), ...o,
});
const order = (o: Partial<Order>): Order => ({
  clientOrderId: 'x', symbol: 'OTHER', side: 'BUY', quantity: 75, orderType: 'MARKET', orderId: 'o', status: 'FILLED',
  filledQuantity: 75, averageFillPrice: 1, fills: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...o,
} as Order);
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  now: NOW, marketOpen: true, tradingEnabled: true, killSwitchEngaged: false, brokerConnected: true, dataQuality: 'FULL',
  account: account(), positions: [], ordersToday: [], openStrategies: [], ...o,
});
const failed = (p: RiskProposal, c: RiskContext) => evaluateRisk(p, c, L).failed;

describe('risk gateway limits (each just inside, then just outside)', () => {
  it('the baseline proposal passes every check', () => {
    expect(failed(proposal(), ctx())).toEqual([]);
  });

  it.each([
    ['max_risk_per_trade', proposal({ estimatedMaxNetLoss: 2000 }), proposal({ estimatedMaxNetLoss: 2000.01 }), ctx(), ctx()],
    ['max_transaction_costs', proposal({ estimatedTotalCosts: 300 }), proposal({ estimatedTotalCosts: 300.01 }), ctx(), ctx()],
    // Today's net −₹2,000 plus this trade's worst case ₹1,000 = the ₹3,000 daily limit.
    ['daily_loss_limit', proposal(), proposal(), ctx({ account: account({ dailyNetPnL: -2000 }) }), ctx({ account: account({ dailyNetPnL: -2000.01 }) })],
    ['weekly_loss_limit', proposal(), proposal(), ctx({ account: account({ weeklyNetPnL: -5000 }) }), ctx({ account: account({ weeklyNetPnL: -5000.01 }) })],
    ['drawdown_limit', proposal(), proposal(), ctx({ account: account({ maxDrawdownPct: 0.0999 }) }), ctx({ account: account({ maxDrawdownPct: 0.1 }) })],
    ['max_orders_per_day', proposal(), proposal(), ctx({ ordersToday: Array.from({ length: 8 }, () => order({})) }), ctx({ ordersToday: Array.from({ length: 9 }, () => order({})) })],
    // 50 % of ₹1,00,000 equity.
    ['margin_utilization', proposal({ estimatedMargin: 50_000 }), proposal({ estimatedMargin: 50_001 }), ctx(), ctx()],
  ] as const)('%s', (name, okP, badP, okC, badC) => {
    expect(failed(okP, okC)).toEqual([]);
    expect(failed(badP, badC)).toEqual([name]);
  });

  it('a profit earlier today does not loosen the per-trade limit, but leaves room under the daily one', () => {
    const c = ctx({ account: account({ dailyNetPnL: 5000 }) });
    expect(failed(proposal({ estimatedMaxNetLoss: 2000.01 }), c)).toEqual(['max_risk_per_trade']);
  });

  it('duplicate-order lockout: same symbol/side/qty within 30 s, unless the earlier order was rejected', () => {
    const sym = spec(25000).symbol;
    const at = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
    expect(failed(proposal(), ctx({ ordersToday: [order({ symbol: sym, side: 'SELL', createdAt: at(31) })] }))).toEqual([]);
    expect(failed(proposal(), ctx({ ordersToday: [order({ symbol: sym, side: 'SELL', createdAt: at(29), status: 'REJECTED' })] }))).toEqual([]);
    expect(failed(proposal(), ctx({ ordersToday: [order({ symbol: sym, side: 'SELL', createdAt: at(29) })] }))).toEqual([`duplicate:${sym}`]);
  });

  it('unknown margin blocks a proposal with a short leg', () => {
    expect(failed(proposal({ estimatedMargin: null }), ctx())).toEqual(['margin_known']);
  });
});
