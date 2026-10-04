/**
 * @module backtest/eod-engine
 *
 * End-of-day backtest engine for defined-risk index option strategies held
 * to expiry. Built for honesty over flattery:
 *
 * - POINT IN TIME: on trade date D the strategy sees only D's bhavcopy
 *   (published after the close). It cannot trade at D's close — orders fill
 *   at the NEXT trading day's close.
 * - FILLS: no historical bid/ask exists, so every fill pays an explicit,
 *   pessimistic half-spread against the order (see SpreadModel). Selling
 *   below the close, buying above it.
 * - LIQUIDITY: a leg with no row, no trades or no positive close on the fill
 *   day is not filled; the whole trade is skipped and the reason recorded.
 * - LOT SIZE: exact per-contract lot size from the fill day's bhavcopy.
 * - COSTS: the TransactionCostEngine for entry orders; exchange settlement
 *   at expiry (exercise STT, settlement brokerage) through the PnLEngine.
 * - SETTLEMENT: the exchange's final settlement price from the expiry day's
 *   bhavcopy.
 * - ONE POSITION AT A TIME, fixed size, no compounding.
 * - Charge schedules fail closed: dates without a schedule throw.
 *
 * Everything that would make results look better than reality (same-day
 * fills, LTP fills, ignoring costs, skipping failed trades silently) is
 * deliberately excluded.
 */

import type { BhavRecord } from '../history/bhavcopy.js';
import { finalSettlementPrice } from '../history/bhavcopy.js';
import { lotSizeFor, observationKey } from '../data/constants/lot-sizes.js';
import { holidayDataStatus, isNseTradingHoliday, isSpecialSession } from '../data/constants/holidays.js';
import { computeTradePnL, type TradePnL, type TradeInput } from '../pnl/pnl-engine.js';
import { DEFAULT_BROKERAGE_PLAN, type CostOptions } from '../costs/transaction-cost-engine.js';

export interface SpreadModel {
  id: string;
  /** Half the bid-ask spread assumed for an option with this close price (₹). */
  halfSpread(close: number): number;
  description: string;
}

/**
 * Default pessimistic spread: half-spread = max(₹0.10, 2 % of the close).
 * UNVERIFIED — to be calibrated from the quote recorder's real spreads.
 */
export const EOD_PESSIMISTIC_V1: SpreadModel = {
  id: 'EOD_PESSIMISTIC_V1',
  halfSpread: (close) => Math.max(0.1, 0.02 * close),
  description: 'Half-spread = max(₹0.10, 2% of close); not yet calibrated against recorded bid/ask.',
};

/**
 * Spread models for SENSITIVITY ANALYSIS ONLY. The default stays EOD_PESSIMISTIC_V1 until
 * recorded quotes support a calibrated model (docs/EXECUTION_CALIBRATION.md). A model is never
 * chosen because it improves P&L.
 */
export const SPREAD_MODELS: Readonly<Record<string, SpreadModel>> = Object.freeze({
  EOD_ZERO_SPREAD: { id: 'EOD_ZERO_SPREAD', halfSpread: () => 0, description: 'Fill at the close (unrealistic lower bound; sensitivity only).' },
  EOD_ONE_TICK: { id: 'EOD_ONE_TICK', halfSpread: () => 0.05, description: 'Half-spread one tick (₹0.05); optimistic, sensitivity only.' },
  EOD_PESSIMISTIC_V1,
  EOD_PESSIMISTIC_V1_X2: { id: 'EOD_PESSIMISTIC_V1_X2', halfSpread: (c) => 2 * Math.max(0.1, 0.02 * c), description: 'Twice EOD_PESSIMISTIC_V1 (stress).' },
});

export interface LegProposal {
  type: 'CE' | 'PE';
  strike: number;
  side: 'BUY' | 'SELL';
  lots: number;
}

export interface Proposal {
  symbol: string;
  expiry: string;
  legs: LegProposal[];
  reason: string;
}

/** What a strategy may see on the evening of `date`. */
export interface EveningContext {
  date: string;
  /** All rows of that day's bhavcopy for the strategy's symbols. */
  rows: readonly BhavRecord[];
  hasOpenPosition: boolean;
}

export interface EodStrategy {
  id: string;
  version: string;
  fingerprint: string;
  symbols: string[];
  /**
   * A proposal, or null when there is nothing to consider today (routine), or `{ noTrade }` when the
   * strategy's rule applied today but could not be met: recorded in the result, never silent.
   */
  onEvening(ctx: EveningContext): Proposal | NoTrade | null;
}

export type SpecialSessionPolicy = 'NO_FILLS' | 'ALLOW_FILLS';

export interface NoTrade {
  noTrade: string;
}

export interface FilledLeg extends LegProposal {
  /** NSE FinInstrmId of the contract filled (null for data without it). */
  instrumentId: string | null;
  close: number;
  fillPrice: number;
  lotSize: number;
  quantity: number;
  settlementValuePerUnit: number;
}

export interface BacktestTrade {
  id: string;
  signalDate: string;
  entryDate: string;
  expiry: string;
  symbol: string;
  reason: string;
  settlementPrice: number;
  legs: FilledLeg[];
  pnl: TradePnL;
  legPnL: TradePnL[];
}

export interface SkippedSignal {
  signalDate: string;
  reason: string;
}

export interface BacktestResult {
  strategyId: string;
  strategyVersion: string;
  strategyFingerprint: string;
  spreadModel: string;
  specialSessionPolicy: SpecialSessionPolicy;
  /** Orders whose fill was deferred past a special session (NO_FILLS policy). */
  deferredFills: Array<{ signalDate: string; specialSession: string }>;
  /** Brokerage plan used for every cost in this result (charge schedules are chosen by trade date). */
  brokeragePlanId: string;
  from: string;
  to: string;
  tradeDatesUsed: number;
  trades: BacktestTrade[];
  skipped: SkippedSignal[];
  /** Evenings where the strategy's rule applied but produced no proposal, with its reason. */
  noTrade: Array<{ date: string; reason: string }>;
  /** Held contracts whose expiry NSE relabelled while the position was open (followed by instrument id). */
  expiryRelabels: Array<{ date: string; from: string; to: string }>;
  /** Positions still open at the end of the data (not counted). */
  openAtEnd: number;
}

export interface EngineInput {
  strategy: EodStrategy;
  /** Sorted trade dates with stored bhavcopy. */
  tradeDates: string[];
  /** Load one date's rows (already filtered to the strategy's symbols is fine). */
  load: (date: string) => BhavRecord[];
  from: string;
  to: string;
  spread?: SpreadModel;
  costOptions?: CostOptions;
  /** Throw on missing expected trading days (default true). Tests with sparse synthetic data set false. */
  requireContinuousData?: boolean;
  /**
   * Fills in special (Muhurat) sessions: 'NO_FILLS' (default) defers a pending order to the next
   * regular session's close; 'ALLOW_FILLS' treats them like any session (behaviour of results frozen
   * before 2026-10-04, e.g. EXP-0001/0002). Marks and settlement always use every published session.
   */
  specialSessions?: SpecialSessionPolicy;
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const TICK = 0.05;
const toTick = (x: number, dir: 'up' | 'down') =>
  r2((dir === 'up' ? Math.ceil(x / TICK - 1e-9) : Math.floor(x / TICK + 1e-9)) * TICK);

/** Sum leg P&Ls into one strategy-level TradePnL (for metrics). */
export function aggregatePnL(id: string, legs: TradePnL[]): TradePnL {
  const s = (k: keyof TradePnL) => r2(legs.reduce((a, l) => a + (l[k] as number), 0));
  const gross = s('grossPnL');
  const total = s('totalCosts');
  const net = r2(gross - total);
  return {
    tradeId: id,
    direction: 'SHORT',
    grossEntryValue: s('grossEntryValue'),
    grossExitValue: s('grossExitValue'),
    grossPnL: gross,
    brokerage: s('brokerage'),
    stt: s('stt'),
    exchangeCharges: s('exchangeCharges'),
    gst: s('gst'),
    sebiCharges: s('sebiCharges'),
    stampDuty: s('stampDuty'),
    slippage: s('slippage'),
    otherCosts: s('otherCosts'),
    totalCosts: total,
    netPnL: net,
    classification: net > 0.005 ? 'NET_PROFIT' : net < -0.005 ? 'NET_LOSS' : 'NET_BREAKEVEN',
    grossProfitNetLoss: gross > 0 && net <= 0,
    costSource: 'MODEL',
    scheduleIds: [...new Set(legs.flatMap((l) => l.scheduleIds))],
    assumptions: [...new Set(legs.flatMap((l) => l.assumptions))],
  };
}

/**
 * Weekdays in [from, to] that should have been trading days (not an NSE
 * holiday in a year with OFFICIAL holiday data) but have no data. Years
 * without official holiday data are not checked (reported separately).
 */
export function missingTradingDays(dates: readonly string[], from: string, to: string): { missing: string[]; uncheckedYears: number[] } {
  const have = new Set(dates);
  const missing: string[] = [];
  const unchecked = new Set<number>();
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const y = d.getUTCFullYear();
    if (holidayDataStatus(y).verification !== 'OFFICIAL') { unchecked.add(y); continue; }
    if (!isNseTradingHoliday(iso) && !have.has(iso)) missing.push(iso);
  }
  return { missing, uncheckedYears: [...unchecked].sort() };
}

export function runEodBacktest(input: EngineInput): BacktestResult {
  const { strategy, load } = input;
  const spread = input.spread ?? EOD_PESSIMISTIC_V1;
  const dates = input.tradeDates.filter((d) => d >= input.from && d <= input.to).sort();
  if (dates.length > 0 && input.requireContinuousData !== false) {
    const gap = missingTradingDays(dates, dates[0], dates[dates.length - 1]);
    if (gap.missing.length > 0) {
      throw new Error(`Data gap: no bhavcopy for expected trading day(s) ${gap.missing.slice(0, 10).join(', ')}. Download them or fix the holiday list before backtesting.`);
    }
  }
  const symbols = new Set(strategy.symbols);
  const rowsCache = new Map<string, BhavRecord[]>();
  const rowsOf = (d: string) => {
    let r = rowsCache.get(d);
    if (!r) {
      r = load(d).filter((x) => symbols.has(x.symbol));
      rowsCache.set(d, r);
      if (rowsCache.size > 8) rowsCache.delete(rowsCache.keys().next().value as string);
    }
    return r;
  };

  const trades: BacktestTrade[] = [];
  const skipped: SkippedSignal[] = [];
  const policy: SpecialSessionPolicy = input.specialSessions ?? 'NO_FILLS';
  const deferredFills: Array<{ signalDate: string; specialSession: string }> = [];
  const noTrade: Array<{ date: string; reason: string }> = [];
  const expiryRelabels: Array<{ date: string; from: string; to: string }> = [];
  type Pending = { proposal: Proposal; signalDate: string };
  type Open = { proposal: Proposal; signalDate: string; entryDate: string; legs: FilledLeg[] };
  let open: Open | null = null;
  let pending: Pending | null = null;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const rows = rowsOf(d);

    // 1. Fill a pending order at today's close (decided yesterday evening). Under NO_FILLS a special
    //    session is not a fill opportunity: the order waits for the next regular session.
    if (pending && policy === 'NO_FILLS' && isSpecialSession(d)) {
      deferredFills.push({ signalDate: pending.signalDate, specialSession: d });
    } else if (pending) {
      const p: Pending = pending;
      pending = null;
      if (d >= p.proposal.expiry) {
        skipped.push({ signalDate: p.signalDate, reason: `Next trading day ${d} is on/after expiry ${p.proposal.expiry}` });
      } else {
        const obs = new Map<string, number>();
        for (const r of rows) if (r.lotSize !== null) obs.set(observationKey(r.symbol, r.expiry, r.tradeDate), r.lotSize);
        const legs: FilledLeg[] = [];
        let fail: string | null = null;
        for (const l of p.proposal.legs) {
          const row = rows.find((r) => r.symbol === p.proposal.symbol && r.expiry === p.proposal.expiry && r.optionType === l.type && r.strike === l.strike);
          if (!row) { fail = `${l.type} ${l.strike} not listed on ${d}`; break; }
          if (!(row.close !== null && row.close > 0) || !(row.volumeContracts !== null && row.volumeContracts > 0)) {
            fail = `${l.type} ${l.strike} untraded on ${d} (close ${row.close}, volume ${row.volumeContracts})`;
            break;
          }
          const h = spread.halfSpread(row.close);
          const fillPrice = l.side === 'BUY' ? toTick(row.close + h, 'up') : Math.max(TICK, toTick(row.close - h, 'down'));
          const lot = lotSizeFor(p.proposal.symbol, p.proposal.expiry, d, obs).lotSize;
          legs.push({ ...l, instrumentId: row.instrumentId ?? null, close: row.close, fillPrice, lotSize: lot, quantity: l.lots * lot, settlementValuePerUnit: 0 });
        }
        if (fail) skipped.push({ signalDate: p.signalDate, reason: `Not filled: ${fail}` });
        else open = { proposal: p.proposal, signalDate: p.signalDate, entryDate: d, legs };
      }
    }

    // 2. Follow held contracts by instrument id: NSE can relabel a listed contract's expiry
    //    (e.g. the 2025-08-01 Thursday→Tuesday switch). A held contract that vanishes before
    //    its expiry is a data error: fail closed.
    if (open && open.entryDate < d && d <= open.proposal.expiry && open.legs.every((l) => l.instrumentId)) {
      const o: Open = open;
      const byId = new Map(rows.filter((r) => r.instrumentId).map((r) => [r.instrumentId as string, r]));
      const seen = o.legs.map((l) => byId.get(l.instrumentId as string));
      const lost = o.legs.filter((_, k) => !seen[k]);
      if (lost.length) {
        throw new Error(`Held contract(s) ${lost.map((l) => `${l.type} ${l.strike} (id ${l.instrumentId})`).join(', ')} missing from ${d} bhavcopy before expiry ${o.proposal.expiry}`);
      }
      const expiries = new Set(seen.map((r) => r!.expiry));
      if (expiries.size !== 1) throw new Error(`Held legs of ${o.proposal.expiry} report different expiries on ${d}: ${[...expiries].join(', ')}`);
      const now = [...expiries][0];
      if (now !== o.proposal.expiry) {
        if (now < d) throw new Error(`Held contract relabelled to an expiry in the past (${now}) on ${d}`);
        expiryRelabels.push({ date: d, from: o.proposal.expiry, to: now });
        o.proposal = { ...o.proposal, expiry: now };
      }
    }

    // 3. Settle an open position on its expiry day. Never let one silently survive past expiry.
    if (open && d > open.proposal.expiry) {
      throw new Error(`Position expiring ${open.proposal.expiry} was not settled: no data for its expiry day (next data ${d}).`);
    }
    if (open && d === open.proposal.expiry) {
      const o: Open = open;
      open = null;
      const settle = finalSettlementPrice(rows, o.proposal.symbol, o.proposal.expiry);
      const legInputs: TradeInput[] = o.legs.map((l, k) => ({
        tradeId: `${o.proposal.expiry}-${k}`,
        instrument: 'OPTION',
        executions: [{ orderId: `${o.entryDate}-${k}`, side: l.side, quantity: l.quantity, price: l.fillPrice, referencePrice: l.close, tradeDate: o.entryDate }],
        settlement: { settlementPrice: settle, strike: l.strike, optionType: l.type, expiryDate: o.proposal.expiry, underlying: 'INDEX' },
        costOptions: input.costOptions,
      }));
      const legPnL = legInputs.map((t) => computeTradePnL(t));
      o.legs.forEach((l) => {
        l.settlementValuePerUnit = l.type === 'CE' ? Math.max(settle - l.strike, 0) : Math.max(l.strike - settle, 0);
      });
      trades.push({
        id: `${o.proposal.symbol}-${o.proposal.expiry}`,
        signalDate: o.signalDate,
        entryDate: o.entryDate,
        expiry: o.proposal.expiry,
        symbol: o.proposal.symbol,
        reason: o.proposal.reason,
        settlementPrice: settle,
        legs: o.legs,
        pnl: aggregatePnL(`${o.proposal.symbol}-${o.proposal.expiry}`, legPnL),
        legPnL,
      });
    }

    // 4. Evening: the strategy sees today's data only.
    const out = strategy.onEvening({ date: d, rows, hasOpenPosition: open !== null });
    if (out && 'noTrade' in out) noTrade.push({ date: d, reason: out.noTrade });
    const proposal = out && !('noTrade' in out) ? out : null;
    if (proposal) {
      if (open) skipped.push({ signalDate: d, reason: 'Position already open' });
      else if (pending) skipped.push({ signalDate: d, reason: 'Earlier order still waiting to fill' });
      else if (i === dates.length - 1) skipped.push({ signalDate: d, reason: 'No later trade date in range to fill' });
      else pending = { proposal, signalDate: d };
    }
  }

  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategyFingerprint: strategy.fingerprint,
    spreadModel: spread.id,
    specialSessionPolicy: policy,
    deferredFills,
    brokeragePlanId: input.costOptions?.brokeragePlanId ?? DEFAULT_BROKERAGE_PLAN,
    from: dates[0] ?? input.from,
    to: dates[dates.length - 1] ?? input.to,
    tradeDatesUsed: dates.length,
    trades,
    skipped,
    noTrade,
    expiryRelabels,
    openAtEnd: open ? 1 : 0,
  };
}
