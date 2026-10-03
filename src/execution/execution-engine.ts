/**
 * @module execution/execution-engine
 *
 * The ONLY component permitted to call BrokerAdapter.placeOrder.
 *
 * Flow (docs/RISK_MODEL.md, Phase 22):
 *   proposal → data-quality check → cost estimate → NET max-loss estimate →
 *   risk gateway → order preview (+ confirmation code) → HUMAN confirms →
 *   re-validation at current quotes → orders (hedges first) → reconciliation
 *   of expected vs actual → journal.
 *
 * There is no "auto-confirm" path. Confirmation requires the exact code shown
 * in the preview, an operator name, and must happen before the preview expires.
 */

import { createHash } from 'node:crypto';
import type { BrokerAdapter, InstrumentSpec, Order, Quote } from '../broker/types.js';
import type { Journal } from '../broker/journal.js';
import type { DataQualityStatus } from '../data/providers/base.provider.js';
import { calculateOrderCosts, slippagePerUnit, sumCosts } from '../costs/transaction-cost-engine.js';
import type { SlippageModel } from '../costs/types.js';
import { analyzeExpiryPayoff, type StrategyLeg } from '../engine/payoff.js';
import { evaluateRisk, type ProposedLeg, type RiskDecision, type RiskLimits, CONSERVATIVE_DEFAULT_LIMITS } from '../risk/risk-gateway.js';
import type { KillSwitch } from '../risk/kill-switch.js';
import { istDate } from '../utils/time.js';
import { resolveTradingMode } from '../trading/mode.js';

export interface TradeProposalLeg {
  symbol: string;
  side: 'BUY' | 'SELL';
  lots: number;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
}

export interface TradeProposal {
  proposalId: string;
  strategyId: string;
  strategyVersion: string;
  /** Why the strategy generated this proposal (audit trail). */
  reason: string;
  legs: TradeProposalLeg[];
}

export interface PreviewLeg extends TradeProposalLeg {
  quantity: number;
  referencePrice: number;
  expectedFillPrice: number;
  bid: number | null;
  ask: number | null;
  quoteTime: string;
}

export interface OrderPreview {
  previewId: string;
  proposal: TradeProposal;
  legs: PreviewLeg[];
  estimatedEntryCosts: number;
  estimatedRoundTripCosts: number;
  /** Cost of crossing the spread again to exit. */
  estimatedExitSpreadCost: number;
  grossMaxProfit: number;
  grossMaxLoss: number;
  estimatedMaxNetLoss: number;
  estimatedMaxNetProfit: number;
  risk: RiskDecision;
  createdAt: string;
  expiresAt: string;
  /** Must be echoed by the human to confirm. Present only if risk approved. */
  confirmationCode: string | null;
}

export interface ExecutionResult {
  previewId: string;
  status: 'COMPLETED' | 'FAILED_LEG' | 'REJECTED_ON_REVALIDATION';
  orders: Order[];
  reconciliation: ReconciliationRow[];
  detail: string;
}

export interface ReconciliationRow {
  symbol: string;
  expectedQuantity: number;
  actualQuantity: number;
  expectedPrice: number;
  actualPrice: number | null;
  expectedCharges: number;
  actualCharges: number;
  discrepancies: string[];
}

export interface ExecutionEngineDeps {
  broker: BrokerAdapter;
  journal: Journal;
  killSwitch: KillSwitch;
  clock?: () => Date;
  marketOpen: () => boolean;
  /** Data-quality status of the market data that produced the proposal. */
  dataQuality: () => DataQualityStatus;
  tradingEnabled: () => boolean;
  limits?: RiskLimits;
  /** Extra slippage assumed for MARKET orders when estimating fills. */
  marketSlippage?: SlippageModel;
  /** Margin estimate for a set of legs; null = unknown (shorts then rejected). */
  marginEstimate?: (legs: PreviewLeg[]) => number | null;
  previewTtlSeconds?: number;
  env?: Record<string, string | undefined>;
}

export class ExecutionEngine {
  private readonly previews = new Map<string, OrderPreview>();
  private readonly used = new Set<string>();
  private readonly clock: () => Date;
  private readonly limits: RiskLimits;

  constructor(private readonly d: ExecutionEngineDeps) {
    const mode = resolveTradingMode(d.env ?? process.env);
    if (!mode.executionAllowed || mode.mode !== 'paper') {
      throw new Error(`Execution not allowed in mode ${mode.mode}: ${mode.reason}`);
    }
    if (d.broker.mode !== 'paper') throw new Error('ExecutionEngine accepts only a paper broker in this build.');
    this.clock = d.clock ?? (() => new Date());
    this.limits = d.limits ?? CONSERVATIVE_DEFAULT_LIMITS;
  }

  private expectedFill(side: 'BUY' | 'SELL', orderType: 'MARKET' | 'LIMIT', q: Quote, limit?: number): number {
    const touch = side === 'BUY' ? q.ask : q.bid;
    if (touch === null) throw new Error(`No ${side === 'BUY' ? 'ask' : 'bid'} for ${q.symbol}`);
    if (orderType === 'LIMIT') return side === 'BUY' ? Math.min(touch, limit!) : Math.max(touch, limit!);
    const s = this.d.marketSlippage ? slippagePerUnit(this.d.marketSlippage, touch) : 0;
    return side === 'BUY' ? touch + s : Math.max(0, touch - s);
  }

  private async buildPreview(p: TradeProposal): Promise<{ preview: OrderPreview; specs: Map<string, InstrumentSpec> }> {
    const now = this.clock();
    const specs = new Map<string, InstrumentSpec>();
    const legs: PreviewLeg[] = [];
    const proposed: ProposedLeg[] = [];
    for (const l of p.legs) {
      if (!Number.isInteger(l.lots) || l.lots < 1) throw new Error(`Invalid lots for ${l.symbol}`);
      const spec = await this.d.broker.getInstrument(l.symbol);
      const q = await this.d.broker.getQuote(l.symbol);
      specs.set(l.symbol, spec);
      const mid = q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : q.ltp;
      if (mid === null) throw new Error(`No price for ${l.symbol}`);
      const exp = this.expectedFill(l.side, l.orderType, q, l.limitPrice);
      const quantity = l.lots * spec.lotSize;
      legs.push({ ...l, quantity, referencePrice: mid, expectedFillPrice: exp, bid: q.bid, ask: q.ask, quoteTime: q.timestamp.toISOString() });
      proposed.push({ spec, side: l.side, quantity, orderType: l.orderType, limitPrice: l.limitPrice, referencePrice: mid, expectedFillPrice: exp, quote: q });
    }

    // Single-underlying, single-expiry, single-lot-size option strategies only.
    const options = [...specs.values()];
    const sameStructure = options.every((s) => s.kind === 'OPTION' && s.underlyingSymbol === options[0].underlyingSymbol &&
      s.expiry === options[0].expiry && s.lotSize === options[0].lotSize);
    let grossMaxProfit = -Infinity, grossMaxLoss = -Infinity;
    if (sameStructure && options.length > 0) {
      const payoffLegs: StrategyLeg[] = legs.map((l) => {
        const s = specs.get(l.symbol)!;
        return { type: s.optionType!, strike: s.strike!, premium: l.expectedFillPrice, qty: l.lots, action: l.side, expiry: s.expiry };
      });
      const a = analyzeExpiryPayoff(payoffLegs, options[0].lotSize);
      grossMaxProfit = a.maxProfit;
      grossMaxLoss = a.maxLoss;
    }

    const date = istDate(now);
    const entry = sumCosts(legs.map((l) => calculateOrderCosts({ instrument: specs.get(l.symbol)!.kind, exchange: 'NSE', side: l.side, quantity: l.quantity, price: l.expectedFillPrice, tradeDate: date })));
    const exit = sumCosts(legs.map((l) => calculateOrderCosts({ instrument: specs.get(l.symbol)!.kind, exchange: 'NSE', side: l.side === 'BUY' ? 'SELL' : 'BUY', quantity: l.quantity, price: l.expectedFillPrice, tradeDate: date })));
    const exitSpread = legs.reduce((a, l) => a + (l.bid !== null && l.ask !== null ? (l.ask - l.bid) * l.quantity : Infinity), 0);
    const roundTrip = entry.totalCharges + exit.totalCharges;
    const estimatedMaxNetLoss = Number.isFinite(grossMaxLoss) ? -grossMaxLoss + roundTrip + exitSpread : Infinity;
    const estimatedMaxNetProfit = Number.isFinite(grossMaxProfit) ? grossMaxProfit - roundTrip - exitSpread : grossMaxProfit;

    const [account, positions, orders] = await Promise.all([this.d.broker.getAccount(), this.d.broker.getPositions(), this.d.broker.getOrders()]);
    const today = istDate(now);
    const risk = evaluateRisk(
      {
        strategyId: p.strategyId,
        strategyVersion: p.strategyVersion,
        legs: proposed,
        estimatedMaxNetLoss,
        estimatedTotalCosts: roundTrip,
        estimatedMargin: this.d.marginEstimate ? this.d.marginEstimate(legs) : (legs.some((l) => l.side === 'SELL') ? null : 0),
      },
      {
        now,
        marketOpen: this.d.marketOpen(),
        tradingEnabled: this.d.tradingEnabled(),
        killSwitchEngaged: this.d.killSwitch.isEngaged(),
        brokerConnected: this.d.broker.isConnected(),
        dataQuality: this.d.dataQuality(),
        account,
        positions,
        ordersToday: orders.filter((o) => istDate(new Date(o.createdAt)) === today),
        openStrategies: [...new Set(orders.filter((o) => o.strategyId && positions.some((x) => x.symbol === o.symbol)).map((o) => o.strategyId!))],
      },
      this.limits,
    );

    const body = {
      proposal: p, legs,
      estimatedEntryCosts: entry.totalCharges, estimatedRoundTripCosts: roundTrip, estimatedExitSpreadCost: exitSpread,
      grossMaxProfit, grossMaxLoss, estimatedMaxNetLoss, estimatedMaxNetProfit, risk,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (this.d.previewTtlSeconds ?? 60) * 1000).toISOString(),
    };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return {
      preview: { previewId: `PV-${hash.slice(0, 16)}`, ...body, confirmationCode: risk.approved ? hash.slice(16, 24).toUpperCase() : null },
      specs,
    };
  }

  /** Validate a proposal and produce a preview for a human. Places nothing. */
  async preview(p: TradeProposal): Promise<OrderPreview> {
    const { preview } = await this.buildPreview(p);
    this.previews.set(preview.previewId, preview);
    this.d.journal.append('ORDER_PREVIEW', { preview });
    return preview;
  }

  /** Human confirmation. The only method that sends orders. */
  async confirm(previewId: string, confirmationCode: string, operator: string): Promise<ExecutionResult> {
    const pv = this.previews.get(previewId);
    if (!pv) throw new Error('Unknown preview');
    if (this.used.has(previewId)) throw new Error('Preview already used');
    if (!pv.confirmationCode) throw new Error('Preview was not approved by the risk gateway');
    if (confirmationCode !== pv.confirmationCode) throw new Error('Confirmation code mismatch');
    if (!operator.trim()) throw new Error('Operator identity required');
    if (this.clock().getTime() > Date.parse(pv.expiresAt)) throw new Error('Preview expired; create a new one');
    this.used.add(previewId);
    this.d.journal.append('HUMAN_CONFIRMED', { previewId, operator });

    // Re-validate at current quotes; reject if anything moved beyond tolerance.
    const { preview: fresh } = await this.buildPreview(pv.proposal);
    const drift = fresh.legs.map((l, i) => Math.abs(l.expectedFillPrice - pv.legs[i].expectedFillPrice) / Math.max(pv.legs[i].expectedFillPrice, 0.05));
    if (!fresh.risk.approved || drift.some((x) => x > this.limits.maxSlippagePct)) {
      const detail = !fresh.risk.approved ? `Risk re-check failed: ${fresh.risk.failed.join(', ')}` : 'Prices drifted beyond tolerance since preview';
      this.d.journal.append('EXECUTION_REJECTED_ON_REVALIDATION', { previewId, detail });
      return { previewId, status: 'REJECTED_ON_REVALIDATION', orders: [], reconciliation: [], detail };
    }

    // Hedges (BUY legs) first so a short is never placed without its hedge.
    const ordered = [...pv.legs].sort((a, b) => (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1));
    const orders: Order[] = [];
    let failure: string | null = null;
    for (const leg of ordered) {
      const o = await this.d.broker.placeOrder({
        clientOrderId: `${previewId}:${leg.symbol}:${leg.side}`,
        symbol: leg.symbol,
        side: leg.side,
        quantity: leg.quantity,
        orderType: leg.orderType,
        limitPrice: leg.limitPrice,
        referencePrice: leg.referencePrice,
        strategyId: pv.proposal.strategyId,
        strategyVersion: pv.proposal.strategyVersion,
      });
      orders.push(o);
      if (o.status !== 'FILLED') {
        failure = `Leg ${leg.side} ${leg.symbol} ended ${o.status}${o.rejectReason ? ` (${o.rejectReason})` : ''}`;
        break;
      }
    }

    if (failure) {
      for (const o of orders) if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') await this.d.broker.cancelOrder(o.orderId);
      this.d.killSwitch.engage(`FAILED_LEG in ${previewId}: ${failure}. Position may be unhedged — manual review required.`);
    }

    const finalOrders = (await this.d.broker.getOrders()).filter((o) => orders.some((x) => x.orderId === o.orderId));
    const reconciliation = this.reconcile(pv, finalOrders);
    this.d.journal.append('RECONCILIATION', { previewId, reconciliation });
    if (reconciliation.some((r) => r.discrepancies.length > 0)) {
      this.d.journal.append('RECONCILIATION_DISCREPANCY', { previewId, rows: reconciliation.filter((r) => r.discrepancies.length) });
    }
    return {
      previewId,
      status: failure ? 'FAILED_LEG' : 'COMPLETED',
      orders: finalOrders,
      reconciliation,
      detail: failure ?? 'All legs filled',
    };
  }

  /** Expected vs actual. Expected values are never overwritten. */
  private reconcile(pv: OrderPreview, orders: Order[]): ReconciliationRow[] {
    return pv.legs.map((l) => {
      const o = orders.find((x) => x.symbol === l.symbol && x.side === l.side);
      const actualQty = o?.filledQuantity ?? 0;
      const actualPrice = o?.averageFillPrice ?? null;
      const expectedCharges = calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: l.side, quantity: l.quantity, price: l.expectedFillPrice, tradeDate: istDate(this.clock()) }).totalCharges;
      const actualCharges = Math.round((o?.fills.reduce((a, f) => a + f.costs.totalCharges, 0) ?? 0) * 100) / 100;
      const d: string[] = [];
      if (actualQty !== l.quantity) d.push(`quantity ${actualQty} ≠ expected ${l.quantity}`);
      if (actualPrice !== null && Math.abs(actualPrice - l.expectedFillPrice) > 1e-6) d.push(`price ${actualPrice} ≠ expected ${l.expectedFillPrice}`);
      if (Math.abs(actualCharges - expectedCharges) > 0.05) d.push(`charges ₹${actualCharges} ≠ expected ₹${expectedCharges}`);
      return { symbol: l.symbol, expectedQuantity: l.quantity, actualQuantity: actualQty, expectedPrice: l.expectedFillPrice, actualPrice, expectedCharges, actualCharges, discrepancies: d };
    });
  }
}
