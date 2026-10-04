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

export const DEFAULT_BROKERAGE_PLAN = 'ZERODHA-FO-r3';

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

  // Dealer / auto square-off fee: a broker service fee, so GST applies.
  const dealerFee = order.dealerPlaced ? round2(plan.dealerOrderFee) : 0;
  if (order.dealerPlaced) assumptions.push(`Dealer/auto square-off fee ₹${dealerFee} + GST (in otherCharges).`);

  const gstBase =
    (sched.gstOn.includes('brokerage') ? brokerage : 0) +
    (sched.gstOn.includes('exchangeTxn') ? exchangeTxn : 0) +
    (sched.gstOn.includes('ipft') ? ipft : 0) +
    (sched.gstOn.includes('sebiFee') ? sebi : 0) +
    dealerFee;
  const gst = round2(gstBase * sched.gstRate);

  const slippage = round2(opts.slippageRupees ?? 0);
  const totalCharges = round2(brokerage + stt + exchangeTxn + ipft + sebi + stampDuty + gst + dealerFee);

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
    otherCharges: dealerFee,
    totalCharges,
    totalCost: round2(totalCharges + slippage),
    scheduleId: sched.id,
    brokeragePlanId: plan.id,
    assumptions,
  };
}

/** One fill on a contract note. Fills sharing an orderId are one executed order. */
export interface ContractNoteFill {
  orderId: string;
  instrument: 'OPTION' | 'FUTURE';
  side: Side;
  quantity: number;
  price: number;
}

function roundRupeeHalfUp(x: number): number {
  return Math.round(Math.round(x * 1e6) / 1e6); // de-noise float before half-up rounding
}

/**
 * Charges exactly as a broker contract note presents them: all fills of one
 * trade date and segment are aggregated, brokerage is charged once per
 * executed order, and each statutory component is rounded once on the
 * aggregate according to the plan's `contractNote` rules.
 *
 * Use this to estimate or reconcile a day's charges. Per-order
 * calculateOrderCosts() remains the right tool for marginal costs of a
 * single decision; the two differ only by rounding (typically < ₹1 per day).
 */
export function calculateContractNoteCosts(
  fills: ContractNoteFill[],
  tradeDate: string,
  opts: CostOptions = {},
): CostBreakdown {
  assertDate(tradeDate);
  if (fills.length === 0) throw new Error('Contract note has no fills');
  const sched = scheduleFor(tradeDate, opts.schedules);
  const plan = brokeragePlanFor(opts.brokeragePlanId ?? DEFAULT_BROKERAGE_PLAN, tradeDate, opts.plans);

  let turnover = 0, exch = 0, ipft = 0, sttBase = 0, stampBase = 0, brokerage = 0;
  const orderTurnover = new Map<string, { instrument: 'OPTION' | 'FUTURE'; turnover: number }>();
  for (const f of fills) {
    if (!(f.quantity > 0) || !(f.price >= 0) || !Number.isFinite(f.price)) throw new Error(`Invalid fill in order ${f.orderId}`);
    const t = f.quantity * f.price;
    turnover += t;
    const o = orderTurnover.get(f.orderId) ?? { instrument: f.instrument, turnover: 0 };
    if (o.instrument !== f.instrument) throw new Error(`Order ${f.orderId} mixes instrument kinds`);
    o.turnover += t;
    orderTurnover.set(f.orderId, o);
    if (f.instrument === 'OPTION') {
      exch += t * sched.options.exchangeTxnOnPremium;
      ipft += t * sched.options.ipftOnPremium;
      if (f.side === 'SELL') sttBase += t * sched.options.sttSellOnPremium;
      else stampBase += t * sched.options.stampDutyBuy;
    } else {
      exch += t * sched.futures.exchangeTxn;
      ipft += t * sched.futures.ipft;
      if (f.side === 'SELL') sttBase += t * sched.futures.sttSell;
      else stampBase += t * sched.futures.stampDutyBuy;
    }
  }
  for (const o of orderTurnover.values()) {
    brokerage += o.instrument === 'OPTION'
      ? (o.turnover === 0 ? 0 : plan.options.flatPerExecutedOrder)
      : Math.min(o.turnover * plan.futures.percentOfTurnover, plan.futures.capPerExecutedOrder);
  }

  const cn = plan.contractNote;
  // STT is rounded to the paisa first, then to the rupee (observed: ₹12.495 → ₹12.50 → ₹13).
  const stt = cn.sttRounding === 'RUPEE_HALF_UP' ? roundRupeeHalfUp(round2(sttBase)) : round2(sttBase);
  const stampDuty = cn.stampDutyRounding === 'RUPEE_HALF_UP' ? roundRupeeHalfUp(stampBase) : round2(stampBase);
  brokerage = round2(brokerage);
  const exchangeTxn = round2(exch);
  const ipftR = round2(ipft);
  const sebiFee = round2((turnover / CRORE) * sched.sebiFeePerCrore);
  const gstBase =
    (sched.gstOn.includes('brokerage') ? brokerage : 0) +
    (sched.gstOn.includes('exchangeTxn') ? exchangeTxn : 0) +
    (sched.gstOn.includes('ipft') ? ipftR : 0) +
    (sched.gstOn.includes('sebiFee') ? sebiFee : 0);
  const gst = cn.gstSplit === 'CGST_SGST'
    ? 2 * round2(gstBase * (sched.gstRate / 2))
    : round2(gstBase * sched.gstRate);
  const totalCharges = round2(brokerage + stt + exchangeTxn + ipftR + sebiFee + stampDuty + gst);

  return {
    turnover: round2(turnover),
    brokerage,
    stt,
    exchangeTxn,
    ipft: ipftR,
    sebiFee,
    stampDuty,
    gst: round2(gst),
    slippage: 0,
    otherCharges: 0,
    totalCharges,
    totalCost: totalCharges,
    scheduleId: sched.id,
    brokeragePlanId: plan.id,
    assumptions: [`Contract-note aggregation for ${tradeDate}: ${orderTurnover.size} executed orders, ${fills.length} fills.`],
  };
}

export interface ExpirySettlementForCosts {
  /** Settlement − strike (CE) or strike − settlement (PE), floored at 0. */
  intrinsicPerUnit: number;
  /** Signed units still open at expiry: + long, − short. */
  quantity: number;
  tradeDate: string;
  /** Only cash-settled INDEX options are supported. */
  underlying: 'INDEX';
}

/**
 * Costs of an option position settled by the exchange at expiry
 * (cash-settled index options only):
 * - long ITM (EXERCISED): STT on intrinsic value + settlement brokerage
 * - short ITM (ASSIGNED): settlement brokerage
 * - OTM (EXPIRED_OTM): settlement brokerage, if the plan says so
 * Stock options are physically settled and deliberately unsupported.
 */
export function calculateExpirySettlementCosts(ex: ExpirySettlementForCosts, opts: CostOptions = {}): CostBreakdown {
  assertDate(ex.tradeDate);
  if (ex.underlying !== 'INDEX') {
    throw new Error('Settlement costs for physically-settled stock options are not modelled.');
  }
  if (!(ex.intrinsicPerUnit >= 0) || !Number.isFinite(ex.intrinsicPerUnit) || ex.quantity === 0 || !Number.isFinite(ex.quantity)) {
    throw new Error('Settlement requires intrinsic ≥ 0 and a non-zero quantity');
  }
  const sched = scheduleFor(ex.tradeDate, opts.schedules);
  const plan = brokeragePlanFor(opts.brokeragePlanId ?? DEFAULT_BROKERAGE_PLAN, ex.tradeDate, opts.plans);
  const outcome: 'EXERCISED' | 'ASSIGNED' | 'EXPIRED_OTM' =
    ex.intrinsicPerUnit === 0 ? 'EXPIRED_OTM' : ex.quantity > 0 ? 'EXERCISED' : 'ASSIGNED';
  const intrinsicValue = ex.intrinsicPerUnit * Math.abs(ex.quantity);
  const stt = outcome === 'EXERCISED' ? round2(intrinsicValue * sched.options.sttExerciseOnIntrinsic) : 0;
  const brokerage = plan.expirySettlement.appliesTo.includes(outcome) ? round2(plan.expirySettlement.flatPerContract) : 0;
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
      `Expiry settlement outcome: ${outcome}.`,
      'Settlement: exchange transaction charges, SEBI fee and stamp duty assumed NOT levied — UNVERIFIED.',
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
