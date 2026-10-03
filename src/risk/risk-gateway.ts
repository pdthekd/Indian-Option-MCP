/**
 * @module risk/risk-gateway
 *
 * Deterministic pre-trade risk checks. Pure function of (proposal, context,
 * limits): the same inputs always give the same decision. Every check is
 * evaluated and reported (no short-circuit) so a rejection explains itself.
 *
 * The gateway never relaxes limits based on recent wins/losses, monthly goals
 * or model confidence — none of those are inputs.
 */

import type { DataQualityStatus } from '../data/providers/base.provider.js';
import type { AccountSnapshot, InstrumentSpec, Order, Position, Quote } from '../broker/types.js';

export interface RiskLimits {
  /** Max NET loss (₹, incl. costs) a single proposal may risk. */
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  /** Max drawdown from peak equity, as a fraction (0.1 = 10 %). */
  maxDrawdownPct: number;
  maxOpenPositions: number;
  /** Margin blocked after the trade / equity. */
  maxMarginUtilization: number;
  maxPositionNotional: number;
  maxLotsPerOrder: number;
  maxConcurrentStrategies: number;
  maxOrdersPerDay: number;
  maxQuoteAgeSeconds: number;
  /** (ask − bid) / mid above this is "abnormal". */
  maxSpreadPct: number;
  /** |limit − mid| / mid above this is "price outside tolerance". */
  maxPriceDeviationPct: number;
  /** |expected fill − reference| / reference above this is excessive slippage. */
  maxSlippagePct: number;
  /** Max total estimated transaction costs for one proposal (₹). */
  maxTransactionCostsPerTrade: number;
  /** Identical (symbol, side, qty) orders within this window are duplicates. */
  duplicateWindowSeconds: number;
  /** Minimum acceptable data-quality status. */
  minDataQuality: 'FULL' | 'DEGRADED';
  /** Require every short option leg to be hedged by a long leg (defined risk). */
  requireDefinedRisk: boolean;
}

export const CONSERVATIVE_DEFAULT_LIMITS: Readonly<RiskLimits> = Object.freeze({
  maxRiskPerTrade: 2_000,
  maxDailyLoss: 3_000,
  maxWeeklyLoss: 6_000,
  maxDrawdownPct: 0.1,
  maxOpenPositions: 4,
  maxMarginUtilization: 0.5,
  maxPositionNotional: 2_000_000,
  maxLotsPerOrder: 1,
  maxConcurrentStrategies: 1,
  maxOrdersPerDay: 10,
  maxQuoteAgeSeconds: 5,
  maxSpreadPct: 0.05,
  maxPriceDeviationPct: 0.03,
  maxSlippagePct: 0.02,
  maxTransactionCostsPerTrade: 300,
  duplicateWindowSeconds: 30,
  minDataQuality: 'FULL',
  requireDefinedRisk: true,
});

export interface ProposedLeg {
  spec: InstrumentSpec;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  /** Price the strategy decided on. */
  referencePrice: number;
  /** Price the engine expects to be filled at (bid/ask + slippage). */
  expectedFillPrice: number;
  quote: Quote;
}

export interface RiskProposal {
  strategyId: string;
  strategyVersion: string;
  legs: ProposedLeg[];
  /** Worst-case NET loss incl. costs (₹). Infinity for undefined risk. */
  estimatedMaxNetLoss: number;
  estimatedTotalCosts: number;
  /** Margin the broker/model says the whole proposal requires; null = unknown. */
  estimatedMargin: number | null;
}

export interface RiskContext {
  now: Date;
  marketOpen: boolean;
  tradingEnabled: boolean;
  killSwitchEngaged: boolean;
  brokerConnected: boolean;
  dataQuality: DataQualityStatus;
  account: AccountSnapshot;
  positions: Position[];
  ordersToday: Order[];
  /** Strategy IDs with open positions. */
  openStrategies: string[];
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskDecision {
  approved: boolean;
  checks: RiskCheck[];
  failed: string[];
}

const QUALITY_RANK: Record<DataQualityStatus, number> = { FULL: 0, DEGRADED: 1, STALE: 2, UNAVAILABLE: 3 };

/**
 * For each option type, total long quantity (same underlying, same expiry) in
 * the proposal must cover total short quantity. Any long call caps a short
 * call's loss at the strike difference (e.g. bull call spread); likewise for
 * puts. Pairing is by aggregate quantity per (underlying, expiry, type).
 * Positions outside the proposal are deliberately NOT counted as hedges: they
 * can be closed independently and leave the new short naked.
 */
export function findUnhedgedShorts(legs: Array<Pick<ProposedLeg, 'spec' | 'side' | 'quantity'>>): string[] {
  const book = new Map<string, { short: number; long: number }>();
  for (const l of legs) {
    if (l.spec.kind !== 'OPTION') continue;
    const key = `${l.spec.underlyingSymbol}|${l.spec.expiry}|${l.spec.optionType}`;
    const b = book.get(key) ?? { short: 0, long: 0 };
    if (l.side === 'SELL') b.short += l.quantity; else b.long += l.quantity;
    book.set(key, b);
  }
  const unhedged: string[] = [];
  for (const [key, b] of book) if (b.short > b.long) unhedged.push(`${key}: short ${b.short}, long ${b.long}`);
  return unhedged;
}

export function evaluateRisk(p: RiskProposal, ctx: RiskContext, limits: RiskLimits = CONSERVATIVE_DEFAULT_LIMITS): RiskDecision {
  const checks: RiskCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const a = ctx.account;

  add('kill_switch', !ctx.killSwitchEngaged, ctx.killSwitchEngaged ? 'Kill switch engaged' : 'off');
  add('trading_enabled', ctx.tradingEnabled, ctx.tradingEnabled ? 'enabled' : 'Trading disabled');
  add('market_open', ctx.marketOpen, ctx.marketOpen ? 'open' : 'Market closed lockout');
  add('broker_connected', ctx.brokerConnected, ctx.brokerConnected ? 'connected' : 'Broker disconnected lockout');
  add('data_quality', QUALITY_RANK[ctx.dataQuality] <= QUALITY_RANK[limits.minDataQuality],
    `data ${ctx.dataQuality}, minimum ${limits.minDataQuality}`);
  add('has_legs', p.legs.length > 0, `${p.legs.length} legs`);

  add('defined_max_loss', Number.isFinite(p.estimatedMaxNetLoss) && p.estimatedMaxNetLoss >= 0,
    Number.isFinite(p.estimatedMaxNetLoss) ? `₹${p.estimatedMaxNetLoss.toFixed(2)}` : 'Unlimited / unknown max loss');
  add('max_risk_per_trade', p.estimatedMaxNetLoss <= limits.maxRiskPerTrade,
    `net max loss ₹${p.estimatedMaxNetLoss} vs limit ₹${limits.maxRiskPerTrade}`);
  add('max_transaction_costs', p.estimatedTotalCosts <= limits.maxTransactionCostsPerTrade,
    `costs ₹${p.estimatedTotalCosts.toFixed(2)} vs limit ₹${limits.maxTransactionCostsPerTrade}`);

  if (limits.requireDefinedRisk) {
    const u = findUnhedgedShorts(p.legs);
    add('hedge_present', u.length === 0, u.length ? `Missing hedge: ${u.join('; ')}` : 'all short legs hedged');
  }

  // Loss limits use NET P&L; projected worst case includes this trade's max loss.
  add('daily_loss_limit', -a.dailyNetPnL + p.estimatedMaxNetLoss <= limits.maxDailyLoss,
    `today net ₹${a.dailyNetPnL}, worst case after trade ₹${(a.dailyNetPnL - p.estimatedMaxNetLoss).toFixed(2)}, limit −₹${limits.maxDailyLoss}`);
  add('weekly_loss_limit', -a.weeklyNetPnL + p.estimatedMaxNetLoss <= limits.maxWeeklyLoss,
    `week net ₹${a.weeklyNetPnL}, limit −₹${limits.maxWeeklyLoss}`);
  add('drawdown_limit', a.maxDrawdownPct < limits.maxDrawdownPct,
    `max drawdown ${(a.maxDrawdownPct * 100).toFixed(2)}% vs ${(limits.maxDrawdownPct * 100).toFixed(2)}%`);

  const newSymbols = new Set(p.legs.map((l) => l.spec.symbol));
  const openSymbols = new Set(ctx.positions.filter((x) => x.quantity !== 0).map((x) => x.symbol));
  const openAfter = new Set([...openSymbols, ...newSymbols]).size;
  add('max_open_positions', openAfter <= limits.maxOpenPositions, `${openAfter} vs ${limits.maxOpenPositions}`);

  const strategiesAfter = new Set([...ctx.openStrategies, p.strategyId]).size;
  add('max_concurrent_strategies', strategiesAfter <= limits.maxConcurrentStrategies, `${strategiesAfter} vs ${limits.maxConcurrentStrategies}`);

  add('max_orders_per_day', ctx.ordersToday.length + p.legs.length <= limits.maxOrdersPerDay,
    `${ctx.ordersToday.length} + ${p.legs.length} vs ${limits.maxOrdersPerDay}`);

  if (p.estimatedMargin === null) {
    add('margin_known', !p.legs.some((l) => l.side === 'SELL'), 'Margin unknown for a proposal with short legs');
  } else {
    const util = (a.marginBlocked + p.estimatedMargin) / Math.max(a.equity, 1);
    add('margin_utilization', util <= limits.maxMarginUtilization, `${(util * 100).toFixed(1)}% vs ${(limits.maxMarginUtilization * 100).toFixed(1)}%`);
  }

  const windowStart = ctx.now.getTime() - limits.duplicateWindowSeconds * 1000;
  for (const leg of p.legs) {
    const s = leg.spec.symbol;
    const lots = leg.quantity / leg.spec.lotSize;
    add(`lots:${s}`, Number.isInteger(lots) && lots >= 1 && lots <= limits.maxLotsPerOrder, `${lots} lots vs max ${limits.maxLotsPerOrder}`);
    const notional = leg.expectedFillPrice * leg.quantity;
    add(`notional:${s}`, notional <= limits.maxPositionNotional, `₹${notional.toFixed(0)} vs ₹${limits.maxPositionNotional}`);

    const q = leg.quote;
    const ageS = (ctx.now.getTime() - q.timestamp.getTime()) / 1000;
    add(`quote_fresh:${s}`, ageS >= -1 && ageS <= limits.maxQuoteAgeSeconds, `quote age ${ageS.toFixed(1)}s (stale-data lockout above ${limits.maxQuoteAgeSeconds}s)`);
    if (q.bid === null || q.ask === null || q.bid <= 0 || q.ask < q.bid) {
      add(`spread:${s}`, false, 'No two-sided quote');
    } else {
      const mid = (q.bid + q.ask) / 2;
      const spread = (q.ask - q.bid) / mid;
      add(`spread:${s}`, spread <= limits.maxSpreadPct, `spread ${(spread * 100).toFixed(2)}% vs ${(limits.maxSpreadPct * 100).toFixed(2)}% (abnormal-spread lockout)`);
      if (leg.orderType === 'LIMIT' && leg.limitPrice !== undefined) {
        const dev = Math.abs(leg.limitPrice - mid) / mid;
        add(`price_tolerance:${s}`, dev <= limits.maxPriceDeviationPct, `limit deviates ${(dev * 100).toFixed(2)}% from mid`);
      }
    }
    const slip = Math.abs(leg.expectedFillPrice - leg.referencePrice) / Math.max(leg.referencePrice, 0.05);
    add(`slippage:${s}`, slip <= limits.maxSlippagePct, `expected slippage ${(slip * 100).toFixed(2)}% vs ${(limits.maxSlippagePct * 100).toFixed(2)}%`);

    const dup = ctx.ordersToday.some((o) => o.symbol === s && o.side === leg.side && o.quantity === leg.quantity &&
      o.status !== 'REJECTED' && Date.parse(o.createdAt) >= windowStart);
    add(`duplicate:${s}`, !dup, dup ? `Identical order within ${limits.duplicateWindowSeconds}s (duplicate-order lockout)` : 'none');
  }

  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  return { approved: failed.length === 0, checks, failed };
}
