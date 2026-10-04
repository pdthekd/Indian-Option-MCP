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
import { computeTradePnL, type TradePnL, type TradeInput } from '../pnl/pnl-engine.js';
import type { CostOptions } from '../costs/transaction-cost-engine.js';

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
  onEvening(ctx: EveningContext): Proposal | null;
}

export interface FilledLeg extends LegProposal {
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
  from: string;
  to: string;
  tradeDatesUsed: number;
  trades: BacktestTrade[];
  skipped: SkippedSignal[];
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

export function runEodBacktest(input: EngineInput): BacktestResult {
  const { strategy, load } = input;
  const spread = input.spread ?? EOD_PESSIMISTIC_V1;
  const dates = input.tradeDates.filter((d) => d >= input.from && d <= input.to).sort();
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
  type Pending = { proposal: Proposal; signalDate: string };
  type Open = { proposal: Proposal; signalDate: string; entryDate: string; legs: FilledLeg[] };
  let open: Open | null = null;
  let pending: Pending | null = null;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const rows = rowsOf(d);

    // 1. Fill a pending order at today's close (decided yesterday evening).
    if (pending) {
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
          legs.push({ ...l, close: row.close, fillPrice, lotSize: lot, quantity: l.lots * lot, settlementValuePerUnit: 0 });
        }
        if (fail) skipped.push({ signalDate: p.signalDate, reason: `Not filled: ${fail}` });
        else open = { proposal: p.proposal, signalDate: p.signalDate, entryDate: d, legs };
      }
    }

    // 2. Settle an open position on its expiry day.
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

    // 3. Evening: the strategy sees today's data only.
    const proposal = strategy.onEvening({ date: d, rows, hasOpenPosition: open !== null });
    if (proposal) {
      if (open) skipped.push({ signalDate: d, reason: 'Position already open' });
      else if (i === dates.length - 1) skipped.push({ signalDate: d, reason: 'No later trade date in range to fill' });
      else pending = { proposal, signalDate: d };
    }
  }

  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategyFingerprint: strategy.fingerprint,
    spreadModel: spread.id,
    from: dates[0] ?? input.from,
    to: dates[dates.length - 1] ?? input.to,
    tradeDatesUsed: dates.length,
    trades,
    skipped,
    openAtEnd: open ? 1 : 0,
  };
}
