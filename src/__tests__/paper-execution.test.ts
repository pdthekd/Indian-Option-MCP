/**
 * PaperBroker, Journal, RiskGateway, KillSwitch, TradingMode and
 * ExecutionEngine tests. Fully deterministic (injected clock).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaperBroker } from '../broker/paper-broker.js';
import { Journal } from '../broker/journal.js';
import type { InstrumentSpec, Quote } from '../broker/types.js';
import { KillSwitch, KILL_SWITCH_RESET_PHRASE } from '../risk/kill-switch.js';
import { findUnhedgedShorts, CONSERVATIVE_DEFAULT_LIMITS, type RiskLimits } from '../risk/risk-gateway.js';
import { resolveTradingMode } from '../trading/mode.js';
import { ExecutionEngine } from '../execution/execution-engine.js';

let t = new Date('2026-10-05T05:00:00Z'); // 10:30 IST Monday
const clock = () => t;
const advance = (ms: number) => { t = new Date(t.getTime() + ms); };

const spec = (strike: number, type: 'CE' | 'PE'): InstrumentSpec => ({
  symbol: `NIFTY26OCT${strike}${type}`, kind: 'OPTION', underlying: 'INDEX', lotSize: 65, tickSize: 0.05,
  expiry: '2026-10-06', strike, optionType: type, underlyingSymbol: 'NIFTY',
});
const quote = (symbol: string, bid: number, ask: number, qty = 650): Quote => ({
  symbol, bid, ask, bidQty: qty, askQty: qty, ltp: (bid + ask) / 2, timestamp: clock(),
});

const CE25000 = spec(25000, 'CE');
const CE25200 = spec(25200, 'CE');

function newBroker(extra: Partial<ConstructorParameters<typeof PaperBroker>[0]> = {}) {
  const b = new PaperBroker({ initialCapital: 200_000, clock, ...extra });
  b.registerInstrument(CE25000);
  b.registerInstrument(CE25200);
  b.setQuote(quote(CE25000.symbol, 100, 101));
  b.setQuote(quote(CE25200.symbol, 40, 40.5));
  return b;
}

beforeEach(() => { t = new Date('2026-10-05T05:00:00Z'); });

describe('PaperBroker fills and validation', () => {
  it('market BUY fills at the ASK (not LTP) and charges full costs', async () => {
    const b = newBroker();
    const o = await b.placeOrder({ clientOrderId: 'c1', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    expect(o.status).toBe('FILLED');
    expect(o.averageFillPrice).toBe(101);
    expect(o.fills[0].costs.brokerage).toBe(20);
    expect(o.fills[0].costs.stampDuty).toBeGreaterThan(0);
  });

  it('rejects quantities that are not lot multiples and prices off the tick grid', async () => {
    const b = newBroker();
    expect((await b.placeOrder({ clientOrderId: 'q', symbol: CE25000.symbol, side: 'BUY', quantity: 70, orderType: 'MARKET' })).status).toBe('REJECTED');
    expect((await b.placeOrder({ clientOrderId: 't', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'LIMIT', limitPrice: 100.03 })).rejectReason).toMatch(/TICK/);
  });

  it('idempotent clientOrderId: replay returns the same order; changed params are refused', async () => {
    const b = newBroker();
    const a = await b.placeOrder({ clientOrderId: 'same', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    const again = await b.placeOrder({ clientOrderId: 'same', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    expect(again.orderId).toBe(a.orderId);
    expect((await b.getOrders()).length).toBe(1);
    await expect(b.placeOrder({ clientOrderId: 'same', symbol: CE25000.symbol, side: 'BUY', quantity: 130, orderType: 'MARKET' })).rejects.toThrow();
  });

  it('partial fill against displayed quantity, delayed fill on the next quote', async () => {
    const b = newBroker();
    b.setQuote(quote(CE25000.symbol, 100, 101, 65));
    const o = await b.placeOrder({ clientOrderId: 'p', symbol: CE25000.symbol, side: 'BUY', quantity: 195, orderType: 'MARKET' });
    expect(o.status).toBe('PARTIALLY_FILLED');
    expect(o.filledQuantity).toBe(65);
    advance(1000);
    b.setQuote(quote(CE25000.symbol, 100.5, 101.5, 650));
    const after = (await b.getOrders())[0];
    expect(after.status).toBe('FILLED');
    expect(after.fills.length).toBe(2);
    expect(after.fills[1].costs.brokerage).toBe(0); // brokerage once per executed order
  });

  it('limit order rests until the market reaches it, and can be cancelled', async () => {
    const b = newBroker();
    const o = await b.placeOrder({ clientOrderId: 'l', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'LIMIT', limitPrice: 95 });
    expect(o.status).toBe('OPEN');
    const c = await b.cancelOrder(o.orderId);
    expect(c.status).toBe('CANCELLED');
  });

  it('never fills on a stale quote', async () => {
    const b = newBroker();
    advance(10_000);
    const o = await b.placeOrder({ clientOrderId: 's', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    expect(o.status).toBe('OPEN');
    expect(b.journal.ofType('FILL_SKIPPED_STALE_QUOTE').length).toBe(1);
  });

  it('rejects shorts when no margin model is configured (fail closed)', async () => {
    const b = newBroker();
    const o = await b.placeOrder({ clientOrderId: 'sh', symbol: CE25000.symbol, side: 'SELL', quantity: 65, orderType: 'MARKET' });
    expect(o.status).toBe('REJECTED');
    expect(o.rejectReason).toMatch(/MARGIN_MODEL_UNAVAILABLE/);
  });

  it('rejects when funds are insufficient', async () => {
    const b = new PaperBroker({ initialCapital: 1_000, clock });
    b.registerInstrument(CE25000);
    b.setQuote(quote(CE25000.symbol, 100, 101));
    const o = await b.placeOrder({ clientOrderId: 'f', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    expect(o.rejectReason).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('PaperBroker reports NET, never gross-only', () => {
  it('a small gross win that costs more than it makes is a NET LOSS', async () => {
    const b = newBroker();
    await b.placeOrder({ clientOrderId: 'o', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' }); // @101
    advance(1000);
    b.setQuote(quote(CE25000.symbol, 101.5, 102));
    await b.placeOrder({ clientOrderId: 'x', symbol: CE25000.symbol, side: 'SELL', quantity: 65, orderType: 'MARKET' }); // @101.5
    const acct = await b.getAccount();
    const trade = acct.closedTrades[0];
    expect(trade.grossPnL).toBeCloseTo(0.5 * 65, 2);
    expect(trade.netPnL).toBeLessThan(0);
    expect(trade.classification).toBe('NET_LOSS');
    expect(trade.grossProfitNetLoss).toBe(true);
    // Account identity: equity − capital = realized gross − charges.
    expect(acct.netPnL).toBeCloseTo(acct.realizedGrossPnL - acct.totalChargesPaid, 2);
    expect(acct.netPnL).toBeCloseTo(trade.netPnL, 2);
  });

  it('expiry settlement of a long ITM index call pays exercise STT', async () => {
    const b = newBroker();
    await b.placeOrder({ clientOrderId: 'e', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    const tr = b.settleExpiry(CE25000.symbol, 25300)!;
    expect(tr.grossPnL).toBeCloseTo((300 - 101) * 65, 2);
    expect(tr.stt).toBeCloseTo(300 * 65 * 0.0015, 2);
    expect((await b.getPositions()).length).toBe(0);
  });

  it('tracks drawdown and daily net P&L', async () => {
    const b = newBroker();
    await b.placeOrder({ clientOrderId: 'd', symbol: CE25000.symbol, side: 'BUY', quantity: 65, orderType: 'MARKET' });
    advance(1000);
    b.setQuote(quote(CE25000.symbol, 60, 61));
    const a = await b.getAccount();
    expect(a.maxDrawdown).toBeGreaterThan(2500);
    expect(a.dailyNetPnL).toBeLessThan(-2500);
  });
});

describe('Journal', () => {
  it('is hash-chained and detects tampering of a persisted file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'));
    const f = join(dir, 'j.jsonl');
    const j = new Journal(f, clock);
    j.append('A', { x: 1 });
    j.append('B', { access_token: 'should-not-persist' });
    expect(j.verify().ok).toBe(true);
    expect(readFileSync(f, 'utf8')).not.toContain('should-not-persist');
    expect(new Journal(f, clock).all().length).toBe(2); // reload verifies
    writeFileSync(f, readFileSync(f, 'utf8').replace('"x":1', '"x":2'));
    expect(() => new Journal(f, clock)).toThrow(/verification/);
  });
  it('entries are frozen', () => {
    const j = new Journal(undefined, clock);
    const e = j.append('A', { x: 1 });
    expect(Object.isFrozen(e)).toBe(true);
  });
});

describe('Kill switch and trading mode', () => {
  it('kill switch latches until a human resets with the exact phrase', () => {
    const k = new KillSwitch();
    k.engage('test');
    k.engage('second');
    expect(k.getReason()).toBe('test');
    expect(() => k.reset('ok', 'me')).toThrow();
    k.reset(KILL_SWITCH_RESET_PHRASE, 'operator');
    expect(k.isEngaged()).toBe(false);
  });
  it('mode defaults to paper; live is impossible; unknown fails', () => {
    expect(resolveTradingMode({}).mode).toBe('paper');
    expect(() => resolveTradingMode({ TRADING_MODE: 'live' })).toThrow(/disabled/);
    expect(() => resolveTradingMode({ TRADING_MODE: 'LIVE ' })).toThrow();
    expect(() => resolveTradingMode({ TRADING_MODE: 'yolo' })).toThrow();
    expect(resolveTradingMode({ TRADING_MODE: 'sandbox' }).executionAllowed).toBe(false);
  });
});

describe('Risk gateway', () => {
  it('detects unhedged short option legs', () => {
    expect(findUnhedgedShorts([{ spec: CE25000, side: 'SELL', quantity: 65 }])).toHaveLength(1);
    expect(findUnhedgedShorts([{ spec: CE25000, side: 'SELL', quantity: 65 }, { spec: CE25200, side: 'BUY', quantity: 65 }])).toHaveLength(0);
    // A lower-strike long call also caps the short call's loss (bull call spread).
    expect(findUnhedgedShorts([{ spec: CE25200, side: 'SELL', quantity: 65 }, { spec: CE25000, side: 'BUY', quantity: 65 }])).toHaveLength(0);
    // Ratio: 2 short vs 1 long is not hedged.
    expect(findUnhedgedShorts([{ spec: CE25200, side: 'SELL', quantity: 130 }, { spec: CE25000, side: 'BUY', quantity: 65 }])).toHaveLength(1);
    // A put does not hedge a call.
    expect(findUnhedgedShorts([{ spec: CE25200, side: 'SELL', quantity: 65 }, { spec: spec(25000, 'PE'), side: 'BUY', quantity: 65 }])).toHaveLength(1);
  });
});

describe('ExecutionEngine (human-in-the-loop)', () => {
  const limits: RiskLimits = { ...CONSERVATIVE_DEFAULT_LIMITS, maxRiskPerTrade: 15_000, maxDailyLoss: 20_000, maxWeeklyLoss: 40_000, maxSpreadPct: 0.05, maxTransactionCostsPerTrade: 500 };
  const mk = (broker: PaperBroker, over: Partial<ConstructorParameters<typeof ExecutionEngine>[0]> = {}) => {
    const ks = new KillSwitch(broker.journal);
    const eng = new ExecutionEngine({
      broker, journal: broker.journal, killSwitch: ks, clock, marketOpen: () => true,
      dataQuality: () => 'FULL', tradingEnabled: () => true, limits, env: {}, ...over,
    });
    return { eng, ks };
  };
  const debitSpread = { proposalId: 'p1', strategyId: 'bcs', strategyVersion: '1.0.0', reason: 'test',
    legs: [
      { symbol: CE25000.symbol, side: 'BUY' as const, lots: 1, orderType: 'MARKET' as const },
      { symbol: CE25200.symbol, side: 'SELL' as const, lots: 1, orderType: 'MARKET' as const },
    ] };

  it('refuses to construct in live mode', () => {
    expect(() => mk(newBroker(), { env: { TRADING_MODE: 'live' } })).toThrow();
  });

  it('preview places nothing; confirm requires the exact code and executes hedge first', async () => {
    const broker = newBroker({ marginModel: () => 0 });
    const { eng } = mk(broker, { marginEstimate: () => 0 });
    const pv = await eng.preview(debitSpread);
    expect(pv.risk.approved, pv.risk.failed.join(',')).toBe(true);
    expect(pv.estimatedMaxNetLoss).toBeGreaterThan(-pv.grossMaxLoss); // costs + spread added
    expect((await broker.getOrders()).length).toBe(0);
    await expect(eng.confirm(pv.previewId, 'WRONG', 'me')).rejects.toThrow(/mismatch/);
    const r = await eng.confirm(pv.previewId, pv.confirmationCode!, 'operator');
    expect(r.status).toBe('COMPLETED');
    expect(r.orders[0].side).toBe('BUY');
    expect(r.reconciliation.every((x) => x.actualQuantity === x.expectedQuantity)).toBe(true);
    await expect(eng.confirm(pv.previewId, pv.confirmationCode!, 'operator')).rejects.toThrow(/already used/);
  });

  it('rejects a naked short (unlimited loss, missing hedge)', async () => {
    const broker = newBroker({ marginModel: () => 0 });
    const { eng } = mk(broker, { marginEstimate: () => 0 });
    const pv = await eng.preview({ ...debitSpread, legs: [debitSpread.legs[1]] });
    expect(pv.risk.approved).toBe(false);
    expect(pv.risk.failed).toContain('defined_max_loss');
    expect(pv.risk.failed).toContain('hedge_present');
    expect(pv.confirmationCode).toBeNull();
  });

  it('lockouts: stale data, market closed, kill switch', async () => {
    const broker = newBroker({ marginModel: () => 0 });
    const { eng, ks } = mk(broker, { dataQuality: () => 'STALE', marketOpen: () => false, marginEstimate: () => 0 });
    ks.engage('manual');
    const pv = await eng.preview(debitSpread);
    expect(pv.risk.failed).toEqual(expect.arrayContaining(['data_quality', 'market_open', 'kill_switch']));
  });

  it('lockout: broker disconnected blocks preview, and a disconnect after preview blocks confirmation', async () => {
    // Previously claimed by the test above's name but not exercised (Foundation audit, 2026-10-04).
    const broker = newBroker({ marginModel: () => 0 });
    const { eng } = mk(broker, { marginEstimate: () => 0 });
    broker.setConnected(false);
    // Fails closed before the gateway: a disconnected broker returns no quotes, so no preview (and no code) exists.
    await expect(eng.preview(debitSpread)).rejects.toThrow(/disconnected/);

    broker.setConnected(true);
    const ok = await eng.preview(debitSpread);
    expect(ok.risk.approved, ok.risk.failed.join(',')).toBe(true);
    broker.setConnected(false);
    await expect(eng.confirm(ok.previewId, ok.confirmationCode!, 'operator')).rejects.toThrow();
    broker.setConnected(true);
    expect((await broker.getOrders()).length).toBe(0);
  });

  it('expired preview cannot be confirmed', async () => {
    const broker = newBroker({ marginModel: () => 0 });
    const { eng } = mk(broker, { marginEstimate: () => 0 });
    const pv = await eng.preview(debitSpread);
    advance(61_000);
    await expect(eng.confirm(pv.previewId, pv.confirmationCode!, 'op')).rejects.toThrow(/expired/);
  });

  it('a failed leg engages the kill switch and is recorded', async () => {
    const broker = newBroker({ marginModel: () => 0 });
    const { eng, ks } = mk(broker, { marginEstimate: () => 0 });
    const pv = await eng.preview(debitSpread);
    // Liquidity disappears on the short leg after preview but before confirmation.
    broker.setQuote({ ...quote(CE25200.symbol, 40, 40.5), bidQty: 0 });
    const r = await eng.confirm(pv.previewId, pv.confirmationCode!, 'op');
    expect(r.status).toBe('FAILED_LEG');
    expect(r.orders[0].status).toBe('FILLED'); // hedge went first
    expect(r.orders[1].status).toBe('CANCELLED');
    expect(ks.isEngaged()).toBe(true);
    expect(broker.journal.ofType('KILL_SWITCH_ENGAGED').length).toBe(1);
    expect(r.reconciliation.find((x) => x.symbol === CE25200.symbol)!.discrepancies[0]).toMatch(/quantity 0/);
    // Further proposals are now blocked.
    const again = await eng.preview({ ...debitSpread, proposalId: 'p2' });
    expect(again.risk.failed).toContain('kill_switch');
  });
});
