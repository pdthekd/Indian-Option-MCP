/**
 * TransactionCostEngine, PnLEngine and TaxModel tests.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateOrderCosts, calculateExerciseCosts, scheduleFor, applySlippage, slippagePerUnit,
} from '../costs/transaction-cost-engine.js';
import { NSE_FO_SCHEDULES } from '../config/charges/nse-fo.js';
import type { CostBreakdown } from '../costs/types.js';
import { computeTradePnL, computeStrategyPnL, markToMarket, formatPnL, classify } from '../pnl/pnl-engine.js';
import { estimateTax, incomeTax, taxRulesFor } from '../tax/tax-model.js';

const D = '2026-10-05';

describe('charge schedules', () => {
  it('select by effective date and never overlap', () => {
    expect(scheduleFor('2026-03-31').options.sttSellOnPremium).toBe(0.001);
    expect(scheduleFor('2026-04-01').options.sttSellOnPremium).toBe(0.0015);
    expect(scheduleFor('2026-04-01').futures.sttSell).toBe(0.0005);
    const sorted = [...NSE_FO_SCHEDULES].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].effectiveTo).not.toBeNull();
      expect(sorted[i - 1].effectiveTo! < sorted[i].effectiveFrom).toBe(true);
    }
  });
  it('fail closed outside any schedule', () => {
    expect(() => scheduleFor('2020-01-01')).toThrow(/No charge schedule/);
    expect(() => scheduleFor('05-10-2026')).toThrow();
  });
  it('every schedule records at least one source', () => {
    for (const s of NSE_FO_SCHEDULES) expect(s.sources.length).toBeGreaterThan(0);
  });
});

describe('option order costs (hand-computed, 2026-04-01 schedule)', () => {
  it('BUY 75 @ ₹100', () => {
    const c = calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: 'BUY', quantity: 75, price: 100, tradeDate: D });
    expect(c.turnover).toBe(7500);
    expect(c.brokerage).toBe(20);
    expect(c.stt).toBe(0); // STT on options is sell-side only
    expect(c.exchangeTxn).toBeCloseTo(2.63, 2); // 7500 × 0.03503 %
    expect(c.ipft).toBeCloseTo(0.04, 2); // 7500 × 0.0005 %
    expect(c.sebiFee).toBeCloseTo(0.01, 2); // ₹10/crore
    expect(c.stampDuty).toBeCloseTo(0.23, 2); // 0.003 % buy side
    expect(c.gst).toBeCloseTo(0.18 * (20 + 2.63 + 0.04 + 0.01), 2);
    expect(c.totalCharges).toBeCloseTo(20 + 2.63 + 0.04 + 0.01 + 0.23 + 4.08, 2);
  });
  it('SELL 75 @ ₹120 pays 0.15 % STT on premium and no stamp duty', () => {
    const c = calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: 'SELL', quantity: 75, price: 120, tradeDate: D });
    expect(c.stt).toBeCloseTo(13.5, 2);
    expect(c.stampDuty).toBe(0);
  });
  it('same SELL before 2026-04-01 uses 0.10 % STT', () => {
    const c = calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: 'SELL', quantity: 75, price: 120, tradeDate: '2026-03-30' });
    expect(c.stt).toBeCloseTo(9, 2);
  });
  it('brokerage is per executed order', () => {
    const c = calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: 'BUY', quantity: 150, price: 100, tradeDate: D, executedOrders: 2 });
    expect(c.brokerage).toBe(40);
  });
});

describe('futures order costs', () => {
  it('brokerage capped at ₹20; STT 0.05 % sell; stamp 0.002 % buy', () => {
    const buy = calculateOrderCosts({ instrument: 'FUTURE', exchange: 'NSE', side: 'BUY', quantity: 75, price: 25000, tradeDate: D });
    expect(buy.brokerage).toBe(20);
    expect(buy.stampDuty).toBeCloseTo(1_875_000 * 0.00002, 2);
    const sell = calculateOrderCosts({ instrument: 'FUTURE', exchange: 'NSE', side: 'SELL', quantity: 75, price: 25000, tradeDate: D });
    expect(sell.stt).toBeCloseTo(1_875_000 * 0.0005, 2);
  });
  it('small futures order pays 0.03 % brokerage below the cap', () => {
    const c = calculateOrderCosts({ instrument: 'FUTURE', exchange: 'NSE', side: 'BUY', quantity: 1, price: 1000, tradeDate: D });
    expect(c.brokerage).toBeCloseTo(0.3, 2);
  });
});

describe('exercise and slippage', () => {
  it('ITM long index option exercise pays STT on intrinsic value', () => {
    const c = calculateExerciseCosts({ intrinsicPerUnit: 50, quantity: 75, tradeDate: D, underlying: 'INDEX' });
    expect(c.stt).toBeCloseTo(3750 * 0.0015, 2);
  });
  it('slippage models move price against the order', () => {
    expect(applySlippage('BUY', 100, { kind: 'TICKS', ticks: 2, tickSize: 0.05 })).toBeCloseTo(100.1, 10);
    expect(applySlippage('SELL', 100, { kind: 'BPS', bps: 10 })).toBeCloseTo(99.9, 10);
    expect(slippagePerUnit({ kind: 'SPREAD_FRACTION', fraction: 0.5, bid: 99, ask: 101 }, 100)).toBe(1);
    expect(() => slippagePerUnit({ kind: 'SPREAD_FRACTION', fraction: 0.5, bid: 101, ask: 99 }, 100)).toThrow();
  });
  it('rejects invalid orders', () => {
    expect(() => calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: 'BUY', quantity: 0, price: 1, tradeDate: D })).toThrow();
    expect(() => calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: 'BUY', quantity: 1, price: NaN, tradeDate: D })).toThrow();
  });
});

const fixed = (total: number): CostBreakdown => ({
  turnover: 0, brokerage: total, stt: 0, exchangeTxn: 0, ipft: 0, sebiFee: 0, stampDuty: 0, gst: 0,
  slippage: 0, otherCharges: 0, totalCharges: total, totalCost: total, scheduleId: 'TEST', brokeragePlanId: 'TEST', assumptions: [],
});

describe('PnL engine — net classification', () => {
  it('Gross +₹1,000, costs ₹420 → NET PROFIT ₹580', () => {
    const p = computeTradePnL({
      tradeId: 't1', instrument: 'OPTION',
      executions: [
        { orderId: 'a', side: 'BUY', quantity: 100, price: 50, tradeDate: D, actualCharges: fixed(210) },
        { orderId: 'b', side: 'SELL', quantity: 100, price: 60, tradeDate: D, actualCharges: fixed(210) },
      ],
    });
    expect(p.grossPnL).toBe(1000);
    expect(p.totalCosts).toBe(420);
    expect(p.netPnL).toBe(580);
    expect(p.classification).toBe('NET_PROFIT');
    expect(formatPnL(p)).toContain('NET PROFIT = ₹580.00');
  });
  it('Gross +₹300, costs ₹420 → NET LOSS ₹120 even though gross is positive', () => {
    const p = computeTradePnL({
      tradeId: 't2', instrument: 'OPTION',
      executions: [
        { orderId: 'a', side: 'BUY', quantity: 100, price: 50, tradeDate: D, actualCharges: fixed(210) },
        { orderId: 'b', side: 'SELL', quantity: 100, price: 53, tradeDate: D, actualCharges: fixed(210) },
      ],
    });
    expect(p.grossPnL).toBe(300);
    expect(p.netPnL).toBe(-120);
    expect(p.classification).toBe('NET_LOSS');
    expect(p.grossProfitNetLoss).toBe(true);
    expect(formatPnL(p)).toContain('NET LOSS = ₹120.00');
  });
  it('slippage is attributed separately without double counting', () => {
    const p = computeTradePnL({
      tradeId: 't3', instrument: 'OPTION',
      executions: [
        { orderId: 'a', side: 'BUY', quantity: 75, price: 101, referencePrice: 100, tradeDate: D, actualCharges: fixed(0) },
        { orderId: 'b', side: 'SELL', quantity: 75, price: 109, referencePrice: 110, tradeDate: D, actualCharges: fixed(0) },
      ],
    });
    expect(p.grossPnL).toBe(750); // at reference prices
    expect(p.slippage).toBe(150);
    expect(p.netPnL).toBe((109 - 101) * 75); // = P&L at fill prices
  });
  it('model costs are applied when no contract note is supplied', () => {
    const p = computeTradePnL({
      tradeId: 't4', instrument: 'OPTION',
      executions: [
        { orderId: 'a', side: 'BUY', quantity: 75, price: 100, tradeDate: D },
        { orderId: 'b', side: 'SELL', quantity: 75, price: 100, tradeDate: D },
      ],
    });
    expect(p.grossPnL).toBe(0);
    expect(p.totalCosts).toBeGreaterThan(40);
    expect(p.classification).toBe('NET_LOSS');
    expect(p.costSource).toBe('MODEL');
  });
  it('long ITM option held to expiry includes exercise STT', () => {
    const p = computeTradePnL({
      tradeId: 't5', instrument: 'OPTION',
      executions: [{ orderId: 'a', side: 'BUY', quantity: 75, price: 100, tradeDate: D, actualCharges: fixed(25) }],
      settlement: { settlementPrice: 24250, strike: 24000, optionType: 'CE', expiryDate: '2026-10-06', underlying: 'INDEX' },
    });
    expect(p.grossPnL).toBe((250 - 100) * 75);
    expect(p.stt).toBeCloseTo(250 * 75 * 0.0015, 2);
  });
  it('refuses an open position without settlement', () => {
    expect(() => computeTradePnL({
      tradeId: 't6', instrument: 'OPTION',
      executions: [{ orderId: 'a', side: 'BUY', quantity: 75, price: 100, tradeDate: D }],
    })).toThrow(/not flat/);
  });
  it('strategy aggregation is net', () => {
    const s = computeStrategyPnL('s1', [
      { tradeId: 'l1', instrument: 'OPTION', executions: [
        { orderId: 'a', side: 'SELL', quantity: 75, price: 60, tradeDate: D, actualCharges: fixed(30) },
        { orderId: 'b', side: 'BUY', quantity: 75, price: 58, tradeDate: D, actualCharges: fixed(30) }] },
    ]);
    expect(s.grossStrategyPnL).toBe(150);
    expect(s.netStrategyPnL).toBe(90);
  });
  it('markToMarket nets entry and estimated exit costs', () => {
    const m = markToMarket({ instrument: 'OPTION', quantity: 75, averagePrice: 100, entryCharges: 27 }, 110, D);
    expect(m.grossUnrealizedPnL).toBe(750);
    expect(m.netUnrealizedPnLEstimate).toBeLessThan(750 - 27);
  });
  it('classify thresholds', () => {
    expect(classify(0)).toBe('NET_BREAKEVEN');
    expect(classify(0.01)).toBe('NET_PROFIT');
    expect(classify(-0.01)).toBe('NET_LOSS');
  });
});

describe('TaxModel (estimates)', () => {
  const rules = taxRulesFor('FY2026-27');
  it('no tax up to ₹12 lakh for a resident (87A rebate)', () => {
    expect(incomeTax(1_200_000, rules, true)).toBe(0);
  });
  it('₹15 lakh: slab tax 1,05,000 + 4 % cess = 1,09,200', () => {
    expect(incomeTax(1_500_000, rules, true)).toBe(109_200);
  });
  it('marginal relief just above ₹12 lakh', () => {
    // slab tax 61,500 limited to income above 12L (10,000), + cess
    expect(incomeTax(1_210_000, rules, true)).toBe(10_400);
  });
  it('non-resident gets no rebate', () => {
    expect(incomeTax(1_000_000, rules, false)).toBe(Math.round((20000 + 20000) * 1.04));
  });
  it('attributes incremental tax to trading and labels as estimate', () => {
    const e = estimateTax({ financialYear: 'FY2026-27', netTradingPnL: 300_000, otherTaxableIncome: 1_200_000, residentIndividual: true });
    expect(e.estimatedTaxAttributableToTrading).toBe(109_200);
    expect(e.afterTaxTradingEstimate).toBe(300_000 - 109_200);
    expect(e.label).toMatch(/ESTIMATE ONLY/);
  });
  it('trading loss yields zero attributable tax, not a refund', () => {
    const e = estimateTax({ financialYear: 'FY2026-27', netTradingPnL: -50_000, otherTaxableIncome: 1_500_000, residentIndividual: true });
    expect(e.estimatedTaxAttributableToTrading).toBe(0);
    expect(e.tradingLossNotSetOff).toBe(50_000);
  });
  it('unknown financial year fails closed', () => {
    expect(() => taxRulesFor('FY2030-31')).toThrow();
  });
});
