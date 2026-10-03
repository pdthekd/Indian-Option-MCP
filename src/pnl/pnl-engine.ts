/**
 * @module pnl/pnl-engine
 *
 * The ONE authoritative P&L calculation. Every other component (paper broker,
 * shadow trading, backtests, reports, MCP tools) must call this module rather
 * than computing P&L itself.
 *
 * Conventions
 * - grossPnL is computed at REFERENCE (decision) prices when supplied, else at
 *   executed prices.
 * - slippage = execution shortfall = (executed − reference) against the trade,
 *   summed in ₹. Positive = cost.
 * - netPnL = grossPnL − totalCharges − slippage
 *   ⇔ P&L at executed prices − charges (no double counting).
 * - A trade is a NET PROFIT only if netPnL > 0. Gross results never decide
 *   classification.
 */

import {
  calculateExpirySettlementCosts,
  calculateOrderCosts,
  type CostOptions,
} from '../costs/transaction-cost-engine.js';
import type { CostBreakdown, InstrumentKind, Side } from '../costs/types.js';

export interface Execution {
  orderId: string;
  side: Side;
  /** Units (lots × lot size). */
  quantity: number;
  /** Executed price per unit. */
  price: number;
  /** Decision / arrival price per unit, if known (for slippage attribution). */
  referencePrice?: number;
  /** IST trade date YYYY-MM-DD. */
  tradeDate: string;
  /**
   * Actual charges from a broker contract note. When present they are used
   * as-is (and the model estimate is kept for reconciliation); otherwise the
   * TransactionCostEngine estimates them.
   */
  actualCharges?: CostBreakdown;
}

/** Expiry settlement of an option position still open at expiry. */
export interface ExpirySettlement {
  settlementPrice: number;
  strike: number;
  optionType: 'CE' | 'PE';
  expiryDate: string;
  underlying: 'INDEX';
}

export interface TradeInput {
  tradeId: string;
  instrument: InstrumentKind;
  executions: Execution[];
  /** Required for options with non-zero net quantity after all executions. */
  settlement?: ExpirySettlement;
  costOptions?: CostOptions;
}

export type NetClassification = 'NET_PROFIT' | 'NET_LOSS' | 'NET_BREAKEVEN';

export interface TradePnL {
  tradeId: string;
  direction: 'LONG' | 'SHORT';
  grossEntryValue: number;
  grossExitValue: number;
  grossPnL: number;
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  slippage: number;
  otherCosts: number;
  /** All charges + slippage. */
  totalCosts: number;
  netPnL: number;
  classification: NetClassification;
  /** True when gross > 0 but net ≤ 0 — the case this engine exists to catch. */
  grossProfitNetLoss: boolean;
  costSource: 'ACTUAL' | 'MODEL' | 'MIXED';
  scheduleIds: string[];
  assumptions: string[];
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function classify(netPnL: number): NetClassification {
  if (netPnL > 0.005) return 'NET_PROFIT';
  if (netPnL < -0.005) return 'NET_LOSS';
  return 'NET_BREAKEVEN';
}

/** Compute realized P&L for one instrument round-trip. */
export function computeTradePnL(input: TradeInput): TradePnL {
  const { executions, instrument } = input;
  if (executions.length === 0) throw new Error('Trade has no executions');

  let netQty = 0;
  let buyRef = 0, sellRef = 0;
  let slippage = 0;
  const costs: CostBreakdown[] = [];
  let actualCount = 0;

  for (const e of executions) {
    if (!(e.quantity > 0) || !Number.isFinite(e.price) || e.price < 0) {
      throw new Error(`Invalid execution ${e.orderId}`);
    }
    const ref = e.referencePrice ?? e.price;
    const signedQty = e.side === 'BUY' ? e.quantity : -e.quantity;
    netQty += signedQty;
    if (e.side === 'BUY') buyRef += ref * e.quantity;
    else sellRef += ref * e.quantity;
    const shortfall = (e.side === 'BUY' ? e.price - ref : ref - e.price) * e.quantity;
    slippage += shortfall;

    if (e.actualCharges) {
      costs.push(e.actualCharges);
      actualCount++;
    } else {
      costs.push(
        calculateOrderCosts(
          { instrument, exchange: 'NSE', side: e.side, quantity: e.quantity, price: e.price, tradeDate: e.tradeDate },
          input.costOptions,
        ),
      );
    }
  }

  const first = executions[0];
  const direction: 'LONG' | 'SHORT' = first.side === 'BUY' ? 'LONG' : 'SHORT';
  let settlementValue = 0; // signed: + received, − paid

  if (Math.abs(netQty) > 1e-9) {
    if (instrument !== 'OPTION' || !input.settlement) {
      throw new Error(
        `Trade ${input.tradeId} is not flat (net qty ${netQty}). Supply an expiry settlement (options) or use markToMarket for open positions.`,
      );
    }
    const s = input.settlement;
    const intrinsic = s.optionType === 'CE'
      ? Math.max(s.settlementPrice - s.strike, 0)
      : Math.max(s.strike - s.settlementPrice, 0);
    settlementValue = intrinsic * netQty; // long receives, short pays
    // Exercised, assigned and OTM-expired positions all attract settlement costs.
    costs.push(
      calculateExpirySettlementCosts(
        { intrinsicPerUnit: intrinsic, quantity: netQty, tradeDate: s.expiryDate, underlying: s.underlying },
        input.costOptions,
      ),
    );
  }

  const grossPnL = sellRef - buyRef + settlementValue;
  const grossEntryValue = direction === 'LONG' ? buyRef : sellRef;
  const grossExitValue = direction === 'LONG'
    ? sellRef + Math.max(settlementValue, 0)
    : buyRef + Math.max(-settlementValue, 0);

  const sum = (k: keyof CostBreakdown) => r2(costs.reduce((a, c) => a + (c[k] as number), 0));
  const brokerage = sum('brokerage');
  const stt = sum('stt');
  const exchangeCharges = r2(sum('exchangeTxn') + sum('ipft'));
  const gst = sum('gst');
  const sebiCharges = sum('sebiFee');
  const stampDuty = sum('stampDuty');
  const otherCosts = sum('otherCharges');
  const totalCharges = r2(brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty + otherCosts);
  const slip = r2(slippage);
  const totalCosts = r2(totalCharges + slip);
  const gross = r2(grossPnL);
  const netPnL = r2(gross - totalCosts);

  return {
    tradeId: input.tradeId,
    direction,
    grossEntryValue: r2(grossEntryValue),
    grossExitValue: r2(grossExitValue),
    grossPnL: gross,
    brokerage,
    stt,
    exchangeCharges,
    gst,
    sebiCharges,
    stampDuty,
    slippage: slip,
    otherCosts,
    totalCosts,
    netPnL,
    classification: classify(netPnL),
    grossProfitNetLoss: gross > 0 && netPnL <= 0,
    costSource: actualCount === 0 ? 'MODEL' : actualCount === costs.length ? 'ACTUAL' : 'MIXED',
    scheduleIds: [...new Set(costs.map((c) => c.scheduleId))],
    assumptions: [...new Set(costs.flatMap((c) => c.assumptions))],
  };
}

export interface StrategyPnL {
  strategyId: string;
  trades: TradePnL[];
  grossStrategyPnL: number;
  totalStrategyCosts: number;
  netStrategyPnL: number;
  classification: NetClassification;
  grossProfitNetLoss: boolean;
}

/** Aggregate legs of a multi-leg strategy. */
export function computeStrategyPnL(strategyId: string, trades: TradeInput[]): StrategyPnL {
  const results = trades.map(computeTradePnL);
  const gross = r2(results.reduce((a, t) => a + t.grossPnL, 0));
  const costs = r2(results.reduce((a, t) => a + t.totalCosts, 0));
  const net = r2(gross - costs);
  return {
    strategyId,
    trades: results,
    grossStrategyPnL: gross,
    totalStrategyCosts: costs,
    netStrategyPnL: net,
    classification: classify(net),
    grossProfitNetLoss: gross > 0 && net <= 0,
  };
}

export interface OpenPosition {
  instrument: InstrumentKind;
  /** Signed units: + long, − short. */
  quantity: number;
  averagePrice: number;
  /** Charges already paid to open (₹). */
  entryCharges: number;
}

export interface MarkToMarket {
  grossUnrealizedPnL: number;
  /** Estimated cost to close at the mark (charges only; add slippage via exitSlippageRupees). */
  estimatedExitCosts: number;
  entryCharges: number;
  /** gross − entry charges − estimated exit costs. ESTIMATE. */
  netUnrealizedPnLEstimate: number;
}

/** Unrealized P&L of an open position, net of entry and ESTIMATED exit costs. */
export function markToMarket(
  pos: OpenPosition,
  markPrice: number,
  tradeDate: string,
  costOptions?: CostOptions,
  exitSlippageRupees = 0,
): MarkToMarket {
  if (pos.quantity === 0) throw new Error('Position is flat');
  const gross = (markPrice - pos.averagePrice) * pos.quantity;
  const exit = calculateOrderCosts(
    {
      instrument: pos.instrument,
      exchange: 'NSE',
      side: pos.quantity > 0 ? 'SELL' : 'BUY',
      quantity: Math.abs(pos.quantity),
      price: markPrice,
      tradeDate,
    },
    { ...costOptions, slippageRupees: exitSlippageRupees },
  );
  return {
    grossUnrealizedPnL: r2(gross),
    estimatedExitCosts: exit.totalCost,
    entryCharges: r2(pos.entryCharges),
    netUnrealizedPnLEstimate: r2(gross - pos.entryCharges - exit.totalCost),
  };
}

/** Plain-text summary that always shows GROSS, COSTS and NET together. */
export function formatPnL(p: { grossPnL?: number; grossStrategyPnL?: number; totalCosts?: number; totalStrategyCosts?: number; netPnL?: number; netStrategyPnL?: number }): string {
  const gross = p.grossPnL ?? p.grossStrategyPnL ?? 0;
  const costs = p.totalCosts ?? p.totalStrategyCosts ?? 0;
  const net = p.netPnL ?? p.netStrategyPnL ?? 0;
  const s = (x: number) => `${x >= 0 ? '+' : '-'}₹${Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const c = classify(net);
  return [
    `Gross P&L:     ${s(gross)}`,
    `Trading costs: -₹${costs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Net P&L:       ${s(net)}`,
    `Result:        ${c === 'NET_PROFIT' ? `NET PROFIT = ₹${net.toFixed(2)}` : c === 'NET_LOSS' ? `NET LOSS = ₹${Math.abs(net).toFixed(2)}` : 'NET BREAKEVEN'}`,
  ].join('\n');
}
