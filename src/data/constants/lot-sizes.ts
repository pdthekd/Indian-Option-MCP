/**
 * @module data/constants/lot-sizes
 * @description F&O lot sizes, from NSE's own bhavcopy files.
 *
 * Each contract carries its own lot size, and sizes change over time
 * (periodic NSE revisions, which roll through contract by contract, and
 * corporate actions such as bonuses and splits). So a lot size is looked up
 * by SYMBOL + CONTRACT EXPIRY + TRADE DATE.
 *
 * The history in `lot-history.generated.ts` is derived from every daily
 * F&O bhavcopy since 2024-07-08 (all index and stock contracts). On days
 * when a symbol's contracts had different lot sizes (a revision in
 * progress) the answer depends on the contract and must come from that
 * day's bhavcopy (`observations`); without it, lookups fail closed.
 *
 * Regenerate after downloading new bhavcopies:
 *   npm run build && node dist/bhavcopy-cli.mjs --from <date> && node dist/derive-lot-sizes-cli.mjs
 */

import { LOT_HISTORY, LOT_HISTORY_META } from './lot-history.generated.js';

export type LotSizeVerification =
  /** Read from that day's NSE bhavcopy for this exact contract. */
  | 'EXCHANGE_BHAVCOPY'
  /** Every contract of the symbol had this size on that trade date (daily bhavcopy history). */
  | 'BHAVCOPY_DAILY'
  /** Trade date is after the last downloaded bhavcopy: the latest known size is assumed unchanged. */
  | 'BHAVCOPY_LATEST';

/** Per-contract lot sizes read from bhavcopy: key `${symbol}|${expiry}|${tradeDate}`. */
export type LotSizeObservations = ReadonlyMap<string, number>;

export function observationKey(symbol: string, expiry: string, tradeDate: string): string {
  return `${symbol.toUpperCase()}|${expiry}|${tradeDate}`;
}

export interface LotSizeInfo {
  symbol: string;
  lotSize: number;
  verification: LotSizeVerification;
  source: string;
  expiry: string;
  tradeDate: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = `NSE F&O bhavcopy history ${LOT_HISTORY_META.dataFrom} → ${LOT_HISTORY_META.dataTo}`;

/**
 * Lot size of a contract (symbol + expiry) as traded on `tradeDate`.
 *
 * Order of precedence:
 *  1. exact bhavcopy observation for (symbol, expiry, tradeDate);
 *  2. the daily history, when every contract shared one size that day;
 *  3. after the last downloaded day: the symbol's current size (flagged).
 * Throws for unknown symbols, dates before the history, transition days
 * without an observation, and days the symbol was not in F&O.
 */
export function lotSizeFor(
  symbol: string,
  expiry: string,
  tradeDate: string,
  observations?: LotSizeObservations,
): LotSizeInfo {
  if (!ISO.test(expiry)) throw new Error(`expiry must be YYYY-MM-DD (got "${expiry}")`);
  if (!ISO.test(tradeDate)) throw new Error(`tradeDate must be YYYY-MM-DD (got "${tradeDate}")`);
  if (tradeDate > expiry) throw new Error(`Contract expiring ${expiry} does not trade on ${tradeDate}`);
  const upper = symbol.toUpperCase().trim();

  const observed = observations?.get(observationKey(upper, expiry, tradeDate));
  if (observed !== undefined) {
    return { symbol: upper, lotSize: observed, verification: 'EXCHANGE_BHAVCOPY', source: `NSE bhavcopy ${tradeDate}`, expiry, tradeDate };
  }

  const periods = LOT_HISTORY[upper];
  if (!periods) {
    throw new Error(`"${symbol}" is not an NSE F&O symbol in ${SOURCE}.`);
  }
  if (tradeDate < LOT_HISTORY_META.dataFrom) {
    throw new Error(`No lot-size history before ${LOT_HISTORY_META.dataFrom}. Refusing to guess.`);
  }
  const p = periods.find(([from, to]) => tradeDate >= from && (to === null || tradeDate <= to));
  if (!p) {
    const current = periods[periods.length - 1];
    const left = current[1] !== null && tradeDate > current[1];
    throw new Error(
      left
        ? `${upper} has no F&O contracts after ${current[1]} in ${SOURCE}.`
        : `${upper} lot size on ${tradeDate} falls in a lot-size transition window (or the symbol was not in F&O); ` +
          'it depends on the contract — load that day\'s bhavcopy. Refusing to guess.',
    );
  }
  const beyond = tradeDate > LOT_HISTORY_META.dataTo;
  return {
    symbol: upper,
    lotSize: p[2],
    verification: beyond ? 'BHAVCOPY_LATEST' : 'BHAVCOPY_DAILY',
    source: beyond ? `${SOURCE}; assumed unchanged since ${LOT_HISTORY_META.dataTo}` : SOURCE,
    expiry,
    tradeDate,
  };
}

/**
 * Current lot size of a symbol (its open-ended period), for display only.
 * Use lotSizeFor() for anything tied to a specific contract or date.
 */
export function getLotSize(symbol: string): number {
  const periods = LOT_HISTORY[symbol.toUpperCase().trim()];
  const last = periods?.[periods.length - 1];
  if (!last || last[1] !== null) {
    throw new Error(`Unknown or no-longer-listed F&O symbol "${symbol}" (as of ${LOT_HISTORY_META.dataTo}).`);
  }
  return last[2];
}

/** True if the symbol had F&O contracts on the last downloaded trade date. */
export function isFnOSymbol(symbol: string): boolean {
  const periods = LOT_HISTORY[symbol.toUpperCase().trim()];
  return !!periods && periods[periods.length - 1][1] === null;
}

/** Symbols with F&O contracts on the last downloaded trade date, sorted. */
export function getAllFnOSymbols(): string[] {
  return Object.keys(LOT_HISTORY).filter(isFnOSymbol).sort();
}
