/**
 * @module costs/transaction-cost-engine
 *
 * The ONLY place where transaction costs are computed. Independent of any
 * strategy logic. Every number is traceable to a versioned schedule.
 *
 * Rounding: each charge component is rounded to the paisa per order. Broker
 * contract notes may round at the contract-note level, so small (₹ < 1 per
 * note) differences are expected and must be captured by reconciliation.
 */

import { NSE_FO_SCHEDULES } from '../config/charges/nse-fo.js';
import { BROKERAGE_PLANS } from '../config/charges/brokerage.js';
import type {
  BrokeragePlan,
  ChargeSchedule,
  CostBreakdown,
  OrderForCosts,
  Side,
  SlippageModel,
} from './types.js';

const CRORE = 1e7;

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function inRange(date: string, from: string, to: string | null): boolean {
  return date >= from && (to === null || date <= to);
}

function assertDate(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`tradeDate must be YYYY-MM-DD (got "${d}")`);
}

/** Select the charge schedule in force on `tradeDate`. Fails closed. */
export function scheduleFor(
  tradeDate: string,
  schedules: readonly ChargeSchedule[] = NSE_FO_SCHEDULES,
): ChargeSchedule {
  assertDate(tradeDate);
  const hits = schedules.filter((s) => inRange(tradeDate, s.effectiveFrom, s.effectiveTo));
  if (hits.length !== 1) {
    throw new Error(
      hits.length === 0
        ? `No charge schedule covers ${tradeDate}. Refusing to estimate costs.`
        : `Overlapping charge schedules for ${tradeDate}: ${hits.map((h) => h.id).join(', ')}`,
    );
  }
  return hits[0];
}

/** Select a brokerage plan by id, checking it covers `tradeDate`. */
export function brokeragePlanFor(
  planId: string,
  tradeDate: string,
  plans: readonly BrokeragePlan[] = BROKERAGE_PLANS,
): BrokeragePlan {
  assertDate(tradeDate);
  const p = plans.find((x) => x.id === planId);
  if (!p) throw new Error(`Unknown brokerage plan "${planId}"`);
  if (!inRange(tradeDate, p.effectiveFrom, p.effectiveTo)) {
    throw new Error(`Brokerage plan ${planId} not in force on ${tradeDate}`);
  }
  return p;
}

export const DEFAULT_BROKERAGE_PLAN = 'ZERODHA-FO-2024-10-01';

/**
 * Adverse price movement per unit implied by a slippage model.
 * Always ≥ 0 (a cost).
 */
export function slippagePerUnit(model: SlippageModel, price: number): number {
  switch (model.kind) {
    case 'NONE':
      return 0;
    case 'TICKS':
      if (!(model.ticks >= 0) || !(model.tickSize > 0)) throw new Error('Invalid TICKS slippage model');
      return model.ticks * model.tickSize;
    case 'BPS':
      if (!(model.bps >= 0)) throw new Error('Invalid BPS slippage model');
      return (price * model.bps) / 10_000;
    case 'SPREAD_FRACTION': {
      if (!(model.ask >= model.bid) || !(model.bid > 0) || !(model.fraction >= 0)) {
        throw new Error('Invalid SPREAD_FRACTION slippage model (requires bid > 0 and ask ≥ bid)');
      }
      return (model.ask - model.bid) * model.fraction;
    }
  }
}

/** Price after applying slippage against the order direction. */
export function applySlippage(side: Side, referencePrice: number, model: SlippageModel): number {
  const s = slippagePerUnit(model, referencePrice);
  return side === 'BUY' ? referencePrice + s : Math.max(0, referencePrice - s);
}

function validateOrder(o: OrderForCosts): void {
  assertDate(o.tradeDate);
  if (o.exchange !== 'NSE') throw new Error(`Unsupported exchange ${o.exchange}`);
  if (!(o.quantity > 0) || !Number.isFinite(o.quantity)) throw new Error('quantity must be > 0');
  if (!(o.price >= 0) || !Number.isFinite(o.price)) throw new Error('price must be ≥ 0 and finite');
  // 0 = a further partial fill of an order whose brokerage was already charged.
  if (o.executedOrders !== undefined && !(Number.isInteger(o.executedOrders) && o.executedOrders >= 0)) {
    throw new Error('executedOrders must be an integer ≥ 0');
  }
}

export interface CostOptions {
  brokeragePlanId?: string;
  schedules?: readonly ChargeSchedule[];
  plans?: readonly BrokeragePlan[];
  /**
   * Execution shortfall in ₹ to report as slippage for this order
   * (positive = adverse). The price passed in the order must already be the
   * executed price; slippage is reported, not re-applied to charges.
   */
  slippageRupees?: number;
}

/** Costs for one executed order. */
export function calculateOrderCosts(order: OrderForCosts, opts: CostOptions = {}): CostBreakdown {
  validateOrder(order);
  const sched = scheduleFor(order.tradeDate, opts.schedules);
  const plan = brokeragePlanFor(opts.brokeragePlanId ?? DEFAULT_BROKERAGE_PLAN, order.tradeDate, opts.plans);
  const orders = order.executedOrders ?? 1;
  const turnover = order.price * order.quantity;
  const isBuy = order.side === 'BUY';
  const assumptions: string[] = [];

  let brokerage: number, stt: number, exchangeTxn: number, ipft: number, stampDuty: number;
  if (order.instrument === 'OPTION') {
    brokerage = plan.options.flatPerExecutedOrder * orders;
    if (turnover === 0) {
      brokerage = 0;
      assumptions.push('Zero-premium order: brokerage assumed 0.');
    }
    stt = isBuy ? 0 : turnover * sched.options.sttSellOnPremium;
    exchangeTxn = turnover * sched.options.exchangeTxnOnPremium;
    ipft = turnover * sched.options.ipftOnPremium;
    stampDuty = isBuy ? turnover * sched.options.stampDutyBuy : 0;
  } else {
    brokerage = orders === 0
      ? 0
      : Math.min(turnover * plan.futures.percentOfTurnover, plan.futures.capPerExecutedOrder * orders);
    if (orders === 0) assumptions.push('Futures partial fill: brokerage charged on first fill only (approximation).');
    stt = isBuy ? 0 : turnover * sched.futures.sttSell;
    exchangeTxn = turnover * sched.futures.exchangeTxn;
    ipft = turnover * sched.futures.ipft;
    stampDuty = isBuy ? turnover * sched.futures.stampDutyBuy : 0;
  }
  const sebiFee = (turnover / CRORE) * sched.sebiFeePerCrore;

  brokerage = round2(brokerage);
  stt = round2(stt);
  exchangeTxn = round2(exchangeTxn);
  ipft = round2(ipft);
  stampDuty = round2(stampDuty);
  const sebi = round2(sebiFee);

  const gstBase =
    (sched.gstOn.includes('brokerage') ? brokerage : 0) +
    (sched.gstOn.includes('exchangeTxn') ? exchangeTxn : 0) +
    (sched.gstOn.includes('ipft') ? ipft : 0) +
    (sched.gstOn.includes('sebiFee') ? sebi : 0);
  const gst = round2(gstBase * sched.gstRate);

  const slippage = round2(opts.slippageRupees ?? 0);
  const totalCharges = round2(brokerage + stt + exchangeTxn + ipft + sebi + stampDuty + gst);

  return {
    turnover: round2(turnover),
    brokerage,
    stt,
    exchangeTxn,
    ipft,
    sebiFee: sebi,
    stampDuty,
    gst,
    slippage,
    otherCharges: 0,
    totalCharges,
    totalCost: round2(totalCharges + slippage),
    scheduleId: sched.id,
    brokeragePlanId: plan.id,
    assumptions,
  };
}

export interface ExerciseForCosts {
  /** Settlement price − strike (CE) or strike − settlement (PE); must be > 0. */
  intrinsicPerUnit: number;
  /** Units held long and exercised. */
  quantity: number;
  tradeDate: string;
  /** Only cash-settled INDEX options are supported. */
  underlying: 'INDEX';
}

/**
 * Costs borne by the HOLDER of an in-the-money option exercised at expiry
 * (cash-settled index options only). Stock options are physically settled
 * and are deliberately unsupported here.
 */
export function calculateExerciseCosts(ex: ExerciseForCosts, opts: CostOptions = {}): CostBreakdown {
  assertDate(ex.tradeDate);
  if (ex.underlying !== 'INDEX') {
    throw new Error('Exercise costs for physically-settled stock options are not modelled.');
  }
  if (!(ex.intrinsicPerUnit > 0) || !(ex.quantity > 0)) throw new Error('Exercise requires intrinsic > 0 and quantity > 0');
  const sched = scheduleFor(ex.tradeDate, opts.schedules);
  const plan = brokeragePlanFor(opts.brokeragePlanId ?? DEFAULT_BROKERAGE_PLAN, ex.tradeDate, opts.plans);
  const intrinsicValue = ex.intrinsicPerUnit * ex.quantity;
  const stt = round2(intrinsicValue * sched.options.sttExerciseOnIntrinsic);
  const brokerage = round2(plan.exercise.flatPerContractSettlement);
  const gst = round2((sched.gstOn.includes('brokerage') ? brokerage : 0) * sched.gstRate);
  const totalCharges = round2(stt + brokerage + gst);
  return {
    turnover: round2(intrinsicValue),
    brokerage,
    stt,
    exchangeTxn: 0,
    ipft: 0,
    sebiFee: 0,
    stampDuty: 0,
    gst,
    slippage: 0,
    otherCharges: 0,
    totalCharges,
    totalCost: totalCharges,
    scheduleId: sched.id,
    brokeragePlanId: plan.id,
    assumptions: [
      'Exercise: exchange transaction charges, SEBI fee and stamp duty assumed NOT levied on settlement — UNVERIFIED.',
    ],
  };
}

/** Sum several breakdowns (e.g. legs of a strategy). */
export function sumCosts(items: CostBreakdown[]): Omit<CostBreakdown, 'scheduleId' | 'brokeragePlanId'> & {
  scheduleIds: string[];
  brokeragePlanIds: string[];
} {
  const z = {
    turnover: 0, brokerage: 0, stt: 0, exchangeTxn: 0, ipft: 0, sebiFee: 0,
    stampDuty: 0, gst: 0, slippage: 0, otherCharges: 0, totalCharges: 0, totalCost: 0,
  };
  const assumptions = new Set<string>();
  const sids = new Set<string>();
  const bids = new Set<string>();
  for (const c of items) {
    for (const k of Object.keys(z) as Array<keyof typeof z>) z[k] = round2(z[k] + c[k]);
    c.assumptions.forEach((a) => assumptions.add(a));
    sids.add(c.scheduleId);
    bids.add(c.brokeragePlanId);
  }
  return { ...z, assumptions: [...assumptions], scheduleIds: [...sids], brokeragePlanIds: [...bids] };
}
