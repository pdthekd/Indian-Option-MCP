/**
 * @module broker/paper-broker
 *
 * Realistic paper broker. Simulates fills against the quoted bid/ask (never
 * the LTP), with displayed-quantity partial fills, delayed fills on later
 * quotes, tick/lot validation, cash and margin checks, idempotent order IDs,
 * full transaction costs via the TransactionCostEngine, and an immutable
 * hash-chained journal. Closed trades are evaluated by the PnLEngine, so a
 * paper trade is only ever reported as a NET profit or NET loss.
 *
 * It cannot reach any real broker or exchange.
 */

import { calculateOrderCosts, calculateExerciseCosts, slippagePerUnit, type CostOptions } from '../costs/transaction-cost-engine.js';
import type { CostBreakdown, SlippageModel } from '../costs/types.js';
import { computeTradePnL, markToMarket, type Execution, type TradePnL } from '../pnl/pnl-engine.js';
import { istDate } from '../utils/time.js';
import { Journal } from './journal.js';
import type {
  AccountSnapshot, BrokerAdapter, Fill, InstrumentSpec, Order, OrderRequest, Position, Quote,
} from './types.js';

/** Margin required (₹) to hold `quantity` signed units at `price`; null = unknown. */
export type MarginModel = (spec: InstrumentSpec, signedQuantity: number, price: number) => number | null;

export interface PaperBrokerConfig {
  initialCapital: number;
  clock?: () => Date;
  journal?: Journal;
  /** Max quote age for fills (ms). Older quotes never fill. Default 5 s. */
  maxQuoteAgeMs?: number;
  /** Extra adverse slippage applied to MARKET orders beyond crossing the spread. */
  marketSlippage?: SlippageModel;
  /** Required to accept any order that opens/increases a short. Default: none → shorts rejected. */
  marginModel?: MarginModel;
  costOptions?: CostOptions;
}

interface PosState {
  qty: number;
  avg: number;
  realizedGross: number;
  charges: number;
  /** Executions of the current open cycle (for the PnL engine). */
  cycle: Execution[];
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

function isMultiple(x: number, step: number): boolean {
  const k = Math.round(x / step);
  return Math.abs(k * step - x) < 1e-6;
}

function weekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export class PaperBroker implements BrokerAdapter {
  readonly mode = 'paper' as const;
  readonly name = 'PaperBroker';

  private readonly instruments = new Map<string, InstrumentSpec>();
  private readonly quotes = new Map<string, Quote>();
  private readonly orders = new Map<string, Order>();
  private readonly byClientId = new Map<string, string>();
  private readonly positions = new Map<string, PosState>();
  private readonly closedTrades: TradePnL[] = [];
  private cash: number;
  private seq = 0;
  private connected = true;
  private peakEquity: number;
  private maxDrawdown = 0;
  private maxDrawdownPct = 0;
  private dayKey = '';
  private dayStartEquity: number;
  private wkKey = '';
  private weekStartEquity: number;

  readonly journal: Journal;
  private readonly clock: () => Date;
  private readonly maxQuoteAgeMs: number;

  constructor(private readonly cfg: PaperBrokerConfig) {
    if (!(cfg.initialCapital > 0)) throw new Error('initialCapital must be > 0');
    this.clock = cfg.clock ?? (() => new Date());
    this.journal = cfg.journal ?? new Journal(undefined, this.clock);
    this.maxQuoteAgeMs = cfg.maxQuoteAgeMs ?? 5_000;
    this.cash = cfg.initialCapital;
    this.peakEquity = cfg.initialCapital;
    this.dayStartEquity = cfg.initialCapital;
    this.weekStartEquity = cfg.initialCapital;
    this.journal.append('ACCOUNT_OPENED', { mode: this.mode, initialCapital: cfg.initialCapital });
  }

  // ── Simulation controls (not part of BrokerAdapter) ──────────────────

  registerInstrument(spec: InstrumentSpec): void {
    if (!(spec.lotSize > 0) || !(spec.tickSize > 0)) throw new Error('lotSize and tickSize must be > 0');
    this.instruments.set(spec.symbol, { ...spec });
  }

  /** Feed a new quote; open orders are re-evaluated (delayed / partial fills). */
  setQuote(q: Quote): void {
    if (!this.instruments.has(q.symbol)) throw new Error(`Unknown instrument ${q.symbol}`);
    if (q.bid !== null && q.ask !== null && q.bid > q.ask) throw new Error(`Crossed quote for ${q.symbol}`);
    this.quotes.set(q.symbol, { ...q });
    for (const o of this.orders.values()) {
      if (o.symbol === q.symbol && (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED')) this.tryFill(o);
    }
    this.updateEquityStats();
  }

  /** Simulate broker connectivity loss / recovery. */
  setConnected(c: boolean): void {
    this.connected = c;
    this.journal.append(c ? 'BROKER_CONNECTED' : 'BROKER_DISCONNECTED', {});
  }

  // ── BrokerAdapter ────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  async getInstrument(symbol: string): Promise<InstrumentSpec> {
    const s = this.instruments.get(symbol);
    if (!s) throw new Error(`Unknown instrument ${symbol}`);
    return { ...s };
  }

  async getQuote(symbol: string): Promise<Quote> {
    this.assertConnected();
    const q = this.quotes.get(symbol);
    if (!q) throw new Error(`No quote for ${symbol}`);
    return { ...q };
  }

  async getOrders(): Promise<Order[]> {
    return [...this.orders.values()].map((o) => structuredClone(o));
  }

  async getPositions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [symbol, p] of this.positions) {
      if (p.qty === 0) continue;
      const mark = this.markPrice(symbol);
      out.push({
        symbol,
        quantity: p.qty,
        averagePrice: r2(p.avg),
        realizedGrossPnL: r2(p.realizedGross),
        chargesPaid: r2(p.charges),
        markPrice: mark,
        grossUnrealizedPnL: mark === null ? null : r2((mark - p.avg) * p.qty),
      });
    }
    return out;
  }

  async placeOrder(req: OrderRequest): Promise<Order> {
    this.assertConnected();
    const existingId = this.byClientId.get(req.clientOrderId);
    if (existingId) {
      const ex = this.orders.get(existingId)!;
      const same = ex.symbol === req.symbol && ex.side === req.side && ex.quantity === req.quantity &&
        ex.orderType === req.orderType && ex.limitPrice === req.limitPrice;
      if (!same) throw new Error(`clientOrderId ${req.clientOrderId} reused with different parameters`);
      this.journal.append('ORDER_IDEMPOTENT_REPLAY', { clientOrderId: req.clientOrderId, orderId: ex.orderId });
      return structuredClone(ex);
    }

    const now = this.clock().toISOString();
    const order: Order = {
      ...req,
      orderId: `PB-${++this.seq}`,
      status: 'OPEN',
      filledQuantity: 0,
      averageFillPrice: null,
      fills: [],
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.orderId, order);
    this.byClientId.set(req.clientOrderId, order.orderId);

    const reject = this.validate(order);
    if (reject) {
      order.status = 'REJECTED';
      order.rejectReason = reject;
      this.journal.append('ORDER_REJECTED', { order });
      return structuredClone(order);
    }
    this.journal.append('ORDER_ACCEPTED', { order });
    this.tryFill(order);
    this.updateEquityStats();
    return structuredClone(order);
  }

  async modifyOrder(orderId: string, changes: { quantity?: number; limitPrice?: number }): Promise<Order> {
    this.assertConnected();
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`Unknown order ${orderId}`);
    if (o.status !== 'OPEN' && o.status !== 'PARTIALLY_FILLED') throw new Error(`Order ${orderId} is ${o.status}`);
    const spec = this.instruments.get(o.symbol)!;
    if (changes.quantity !== undefined) {
      if (changes.quantity < o.filledQuantity || !isMultiple(changes.quantity, spec.lotSize) || changes.quantity <= 0) {
        throw new Error('Invalid modified quantity');
      }
    }
    if (changes.limitPrice !== undefined) {
      if (o.orderType !== 'LIMIT' || !(changes.limitPrice > 0) || !isMultiple(changes.limitPrice, spec.tickSize)) {
        throw new Error('Invalid modified limit price');
      }
    }
    if (changes.quantity !== undefined) o.quantity = changes.quantity;
    if (changes.limitPrice !== undefined) o.limitPrice = changes.limitPrice;
    o.updatedAt = this.clock().toISOString();
    if (o.filledQuantity === o.quantity) o.status = 'FILLED';
    this.journal.append('ORDER_MODIFIED', { orderId, changes });
    this.tryFill(o);
    return structuredClone(o);
  }

  async cancelOrder(orderId: string): Promise<Order> {
    this.assertConnected();
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`Unknown order ${orderId}`);
    if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') {
      o.status = 'CANCELLED';
      o.updatedAt = this.clock().toISOString();
      this.journal.append('ORDER_CANCELLED', { orderId, filledQuantity: o.filledQuantity });
    }
    return structuredClone(o);
  }

  async getAccount(): Promise<AccountSnapshot> {
    this.updateEquityStats();
    const { equity, unrealized, exitCosts, margin, shortLiability } = this.valuation();
    let realized = 0, charges = 0;
    for (const p of this.positions.values()) { realized += p.realizedGross; charges += p.charges; }
    return {
      mode: this.mode,
      initialCapital: this.cfg.initialCapital,
      cash: r2(this.cash),
      marginBlocked: r2(margin),
      availableFunds: r2(this.cash - margin - shortLiability),
      realizedGrossPnL: r2(realized),
      unrealizedGrossPnL: r2(unrealized),
      totalChargesPaid: r2(charges),
      netPnL: r2(equity - this.cfg.initialCapital),
      netLiquidationPnLEstimate: r2(equity - this.cfg.initialCapital - exitCosts),
      equity: r2(equity),
      peakEquity: r2(this.peakEquity),
      maxDrawdown: r2(this.maxDrawdown),
      maxDrawdownPct: Math.round(this.maxDrawdownPct * 1e4) / 1e4,
      dayStartEquity: r2(this.dayStartEquity),
      dailyNetPnL: r2(equity - this.dayStartEquity),
      weekStartEquity: r2(this.weekStartEquity),
      weeklyNetPnL: r2(equity - this.weekStartEquity),
      closedTrades: this.closedTrades.map((t) => ({ ...t })),
      asOf: this.clock().toISOString(),
    };
  }

  /**
   * Cash-settle an index option position at expiry. Long ITM positions pay
   * STT on intrinsic value via the cost engine; the closed trade is
   * evaluated by the PnL engine.
   */
  settleExpiry(symbol: string, settlementPrice: number): TradePnL | null {
    const spec = this.instruments.get(symbol);
    if (!spec || spec.kind !== 'OPTION' || spec.underlying !== 'INDEX') {
      throw new Error('Only cash-settled index options can be settled in the paper broker');
    }
    const p = this.positions.get(symbol);
    if (!p || p.qty === 0) return null;
    const intrinsic = spec.optionType === 'CE'
      ? Math.max(settlementPrice - spec.strike!, 0)
      : Math.max(spec.strike! - settlementPrice, 0);
    let exCost: CostBreakdown | null = null;
    if (p.qty > 0 && intrinsic > 0) {
      exCost = calculateExerciseCosts(
        { intrinsicPerUnit: intrinsic, quantity: p.qty, tradeDate: spec.expiry, underlying: 'INDEX' },
        this.cfg.costOptions,
      );
    }
    const trade = computeTradePnL({
      tradeId: `${symbol}-${p.cycle[0]?.orderId ?? 'x'}`,
      instrument: 'OPTION',
      executions: p.cycle,
      settlement: { settlementPrice, strike: spec.strike!, optionType: spec.optionType!, expiryDate: spec.expiry, underlying: 'INDEX' },
      costOptions: this.cfg.costOptions,
    });
    this.cash += intrinsic * p.qty - (exCost?.totalCharges ?? 0);
    p.realizedGross += (intrinsic - p.avg) * p.qty;
    p.charges += exCost?.totalCharges ?? 0;
    p.qty = 0;
    p.avg = 0;
    p.cycle = [];
    this.closedTrades.push(trade);
    this.journal.append('EXPIRY_SETTLED', { symbol, settlementPrice, trade });
    this.updateEquityStats();
    return trade;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.connected) throw new Error('Broker disconnected');
  }

  private validate(o: Order): string | null {
    const spec = this.instruments.get(o.symbol);
    if (!spec) return 'UNKNOWN_INSTRUMENT';
    if (!(o.quantity > 0) || !isMultiple(o.quantity, spec.lotSize)) return `QUANTITY_NOT_LOT_MULTIPLE (lot ${spec.lotSize})`;
    if (o.orderType === 'LIMIT') {
      if (!(o.limitPrice! > 0)) return 'INVALID_LIMIT_PRICE';
      if (!isMultiple(o.limitPrice!, spec.tickSize)) return `LIMIT_PRICE_NOT_TICK_MULTIPLE (tick ${spec.tickSize})`;
    } else if (o.limitPrice !== undefined) {
      return 'MARKET_ORDER_WITH_LIMIT_PRICE';
    }
    if (istDate(this.clock()) > spec.expiry) return 'INSTRUMENT_EXPIRED';

    const q = this.quotes.get(o.symbol);
    const px = o.orderType === 'LIMIT' ? o.limitPrice! : (o.side === 'BUY' ? q?.ask : q?.bid);
    if (px === null || px === undefined) return 'NO_QUOTE_FOR_MARKET_ORDER';

    const pos = this.positions.get(o.symbol)?.qty ?? 0;
    const after = pos + (o.side === 'BUY' ? o.quantity : -o.quantity);
    const est = calculateOrderCosts(
      { instrument: spec.kind, exchange: 'NSE', side: o.side, quantity: o.quantity, price: px, tradeDate: istDate(this.clock()) },
      this.cfg.costOptions,
    );
    const { margin, shortLiability } = this.valuation();
    const available = this.cash - margin - shortLiability;

    if (after < 0 && after < pos) {
      // Opens or increases a short.
      if (!this.cfg.marginModel) return 'MARGIN_MODEL_UNAVAILABLE (short positions disabled)';
      const req = this.cfg.marginModel(spec, after, px);
      if (req === null || !Number.isFinite(req)) return 'MARGIN_UNKNOWN';
      const current = pos < 0 ? this.cfg.marginModel(spec, pos, px) ?? Infinity : 0;
      if (req - current + est.totalCharges > available) return 'INSUFFICIENT_MARGIN';
    }
    if (o.side === 'BUY' && spec.kind === 'OPTION' && px * o.quantity + est.totalCharges > available + (pos < 0 ? px * Math.min(o.quantity, -pos) : 0)) {
      return 'INSUFFICIENT_FUNDS';
    }
    if (spec.kind === 'FUTURE' && after !== 0 && Math.abs(after) > Math.abs(pos)) {
      if (!this.cfg.marginModel) return 'MARGIN_MODEL_UNAVAILABLE (futures disabled)';
      const req = this.cfg.marginModel(spec, after, px);
      if (req === null || req > available) return 'INSUFFICIENT_MARGIN';
    }
    return null;
  }

  private tryFill(o: Order): void {
    if (o.status !== 'OPEN' && o.status !== 'PARTIALLY_FILLED') return;
    if (!this.connected) return;
    const spec = this.instruments.get(o.symbol)!;
    const q = this.quotes.get(o.symbol);
    if (!q) return;
    const age = this.clock().getTime() - q.timestamp.getTime();
    if (age > this.maxQuoteAgeMs || age < -1000) {
      this.journal.append('FILL_SKIPPED_STALE_QUOTE', { orderId: o.orderId, quoteAgeMs: age });
      return;
    }
    const touch = o.side === 'BUY' ? q.ask : q.bid;
    const touchQty = o.side === 'BUY' ? q.askQty : q.bidQty;
    if (touch === null || touchQty === null || touchQty <= 0) return;
    if (o.orderType === 'LIMIT' && (o.side === 'BUY' ? touch > o.limitPrice! : touch < o.limitPrice!)) return;

    const remaining = o.quantity - o.filledQuantity;
    const fillQty = Math.floor(Math.min(remaining, touchQty) / spec.lotSize) * spec.lotSize;
    if (fillQty <= 0) return;

    let price = touch;
    if (o.orderType === 'MARKET' && this.cfg.marketSlippage) {
      const s = slippagePerUnit(this.cfg.marketSlippage, touch);
      price = o.side === 'BUY' ? touch + s : Math.max(spec.tickSize, touch - s);
      // Round against the order to a valid tick.
      price = (o.side === 'BUY' ? Math.ceil(price / spec.tickSize - 1e-9) : Math.floor(price / spec.tickSize + 1e-9)) * spec.tickSize;
      price = r2(price);
    }

    const tradeDate = istDate(this.clock());
    const costs = calculateOrderCosts(
      { instrument: spec.kind, exchange: 'NSE', side: o.side, quantity: fillQty, price, tradeDate, executedOrders: o.fills.length === 0 ? 1 : 0 },
      this.cfg.costOptions,
    );
    const fill: Fill = {
      fillId: `${o.orderId}-F${o.fills.length + 1}`,
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      quantity: fillQty,
      price,
      referencePrice: o.referencePrice ?? price,
      timestamp: this.clock().toISOString(),
      tradeDate,
      costs,
    };
    o.fills.push(fill);
    const prevNotional = (o.averageFillPrice ?? 0) * o.filledQuantity;
    o.filledQuantity += fillQty;
    o.averageFillPrice = r2((prevNotional + price * fillQty) / o.filledQuantity);
    o.status = o.filledQuantity === o.quantity ? 'FILLED' : 'PARTIALLY_FILLED';
    o.updatedAt = fill.timestamp;
    this.applyFill(spec, fill);
    this.journal.append('ORDER_FILL', { fill, orderStatus: o.status });
  }

  private applyFill(spec: InstrumentSpec, f: Fill): void {
    const sign = f.side === 'BUY' ? 1 : -1;
    this.cash += -sign * f.price * f.quantity - f.costs.totalCharges;
    let p = this.positions.get(f.symbol);
    if (!p) {
      p = { qty: 0, avg: 0, realizedGross: 0, charges: 0, cycle: [] };
      this.positions.set(f.symbol, p);
    }
    p.charges += f.costs.totalCharges;

    let remaining = f.quantity;
    // Closing portion (reduces |qty|).
    if (p.qty !== 0 && Math.sign(p.qty) !== sign) {
      const closeQty = Math.min(remaining, Math.abs(p.qty));
      const frac = closeQty / f.quantity;
      p.realizedGross += (f.price - p.avg) * closeQty * -sign;
      p.cycle.push(this.execution(f, closeQty, frac));
      p.qty += sign * closeQty;
      remaining -= closeQty;
      if (p.qty === 0) {
        const trade = computeTradePnL({ tradeId: `${f.symbol}-${p.cycle[0].orderId}`, instrument: spec.kind, executions: p.cycle, costOptions: this.cfg.costOptions });
        this.closedTrades.push(trade);
        this.journal.append('TRADE_CLOSED', { symbol: f.symbol, trade });
        p.cycle = [];
        p.avg = 0;
      }
    }
    // Opening portion (same direction or flip remainder).
    if (remaining > 0) {
      const frac = remaining / f.quantity;
      const newQty = Math.abs(p.qty) + remaining;
      p.avg = (p.avg * Math.abs(p.qty) + f.price * remaining) / newQty;
      p.qty += sign * remaining;
      p.cycle.push(this.execution(f, remaining, frac));
    }
  }

  /** Portion of a fill as a PnL-engine execution with proportional actual charges. */
  private execution(f: Fill, qty: number, frac: number): Execution {
    const c = f.costs;
    const scale = (x: number) => r2(x * frac);
    return {
      orderId: f.orderId,
      side: f.side,
      quantity: qty,
      price: f.price,
      referencePrice: f.referencePrice,
      tradeDate: f.tradeDate,
      actualCharges: {
        ...c,
        turnover: scale(c.turnover), brokerage: scale(c.brokerage), stt: scale(c.stt), exchangeTxn: scale(c.exchangeTxn),
        ipft: scale(c.ipft), sebiFee: scale(c.sebiFee), stampDuty: scale(c.stampDuty), gst: scale(c.gst),
        slippage: 0, otherCharges: scale(c.otherCharges), totalCharges: scale(c.totalCharges), totalCost: scale(c.totalCharges),
      },
    };
  }

  private markPrice(symbol: string): number | null {
    const q = this.quotes.get(symbol);
    if (!q) return null;
    if (q.bid !== null && q.ask !== null) return (q.bid + q.ask) / 2;
    return q.ltp;
  }

  private valuation(): { equity: number; unrealized: number; exitCosts: number; margin: number; shortLiability: number } {
    let positionValue = 0, unrealized = 0, exitCosts = 0, margin = 0, shortLiability = 0;
    const date = istDate(this.clock());
    for (const [symbol, p] of this.positions) {
      if (p.qty === 0) continue;
      const spec = this.instruments.get(symbol)!;
      // Unknown mark → value at average price (no fictitious gain) and flag via null mark in positions.
      const mark = this.markPrice(symbol) ?? p.avg;
      unrealized += (mark - p.avg) * p.qty;
      if (spec.kind === 'OPTION') positionValue += mark * p.qty;
      else positionValue += (mark - p.avg) * p.qty; // futures: variation only (cash not exchanged at entry)
      if (p.qty < 0 && spec.kind === 'OPTION') shortLiability += mark * -p.qty;
      if (p.qty < 0 || spec.kind === 'FUTURE') margin += this.cfg.marginModel?.(spec, p.qty, mark) ?? 0;
      exitCosts += markToMarket({ instrument: spec.kind, quantity: p.qty, averagePrice: p.avg, entryCharges: 0 }, Math.max(mark, 0), date, this.cfg.costOptions).estimatedExitCosts;
    }
    // Futures: entry did move cash by price × qty in applyFill; undo for futures valuation.
    let futuresCashAdj = 0;
    for (const [symbol, p] of this.positions) {
      const spec = this.instruments.get(symbol)!;
      if (spec.kind === 'FUTURE' && p.qty !== 0) futuresCashAdj += p.avg * p.qty;
    }
    const equity = this.cash + futuresCashAdj + positionValue;
    return { equity, unrealized, exitCosts, margin, shortLiability: shortLiability - 0 };
  }

  private updateEquityStats(): void {
    const { equity } = this.valuation();
    const today = istDate(this.clock());
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.dayStartEquity = equity;
    }
    const wk = weekKey(today);
    if (wk !== this.wkKey) {
      this.wkKey = wk;
      this.weekStartEquity = equity;
    }
    if (equity > this.peakEquity) this.peakEquity = equity;
    const dd = this.peakEquity - equity;
    if (dd > this.maxDrawdown) {
      this.maxDrawdown = dd;
      this.maxDrawdownPct = dd / this.peakEquity;
    }
  }
}
