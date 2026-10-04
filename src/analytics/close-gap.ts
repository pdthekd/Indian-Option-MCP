/**
 * Close-vs-quote gap: how far the bhavcopy close (the EOD backtest's reference price) is from the
 * prices actually available near the close.
 *
 * For every contract recorded on a day, take the LAST snapshot stamped 15:20–15:30 IST and compare
 * with that day's bhavcopy close C:
 *   buy cost  = ask − C   (what a buyer at the close really paid above the reference)
 *   sell cost = C − bid   (what a seller really gave up below the reference)
 * The EOD model assumes both equal halfSpread(C) (EOD_PESSIMISTIC_V1: max(0.10, 2 % of C)).
 * Measurement only: it does not change any model (docs/EXECUTION_CALIBRATION.md).
 */

import type { QuoteSnapshotRow } from '../history/quote-recorder.js';
import type { BhavRecord } from '../history/bhavcopy.js';
import { EOD_PESSIMISTIC_V1 } from '../backtest/eod-engine.js';

export const CLOSE_WINDOW_IST = ['15:20', '15:30'] as const;

export interface GapObservation {
  date: string;
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  quotedAtIst: string;
  close: number;
  bid: number;
  ask: number;
  buyCost: number;
  sellCost: number;
  modelHalfSpread: number;
}

export interface GapBucket {
  bucket: string;
  n: number;
  medianBuyCost: number | null;
  medianSellCost: number | null;
  p75Cost: number | null;
  medianModel: number | null;
  /** Share of observations where the model's half-spread is at least the real cost on BOTH sides. */
  modelCoversBoth: number | null;
  closeInsideQuote: number | null;
}

const ist = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;

export function closeGapObservations(quotes: readonly QuoteSnapshotRow[], bhav: readonly BhavRecord[]): GapObservation[] {
  const close = new Map<string, number>();
  for (const b of bhav) {
    if (b.instrumentType !== 'IDX_OPT' || b.strike === null || b.optionType === null) continue;
    if (b.close === null || !(b.close > 0) || !((b.volumeContracts ?? 0) > 0)) continue; // traded contracts only
    close.set(`${b.tradeDate}|${b.symbol}|${b.expiry}|${b.strike}|${b.optionType}`, b.close);
  }
  const last = new Map<string, QuoteSnapshotRow>();
  for (const q of quotes) {
    const t = ist(q.recordedAt);
    const hhmm = t.slice(11, 16);
    if (hhmm < CLOSE_WINDOW_IST[0] || hhmm > CLOSE_WINDOW_IST[1]) continue;
    if (q.quality !== 'FULL' || q.bid === null || q.ask === null || !(q.bid > 0) || !(q.ask >= q.bid)) continue;
    const key = `${t.slice(0, 10)}|${q.symbol}|${q.expiry}|${q.strike}|${q.type}`;
    const prev = last.get(key);
    if (!prev || q.recordedAt > prev.recordedAt) last.set(key, q);
  }
  const out: GapObservation[] = [];
  for (const [key, q] of last) {
    const c = close.get(key);
    if (c === undefined) continue;
    const [date] = key.split('|');
    out.push({
      date, symbol: q.symbol, expiry: q.expiry, strike: q.strike, type: q.type, quotedAtIst: ist(q.recordedAt).slice(11, 19),
      close: c, bid: q.bid as number, ask: q.ask as number,
      buyCost: r2((q.ask as number) - c), sellCost: r2(c - (q.bid as number)), modelHalfSpread: r2(EOD_PESSIMISTIC_V1.halfSpread(c)),
    });
  }
  return out.sort((a, b) => (a.date + a.symbol + a.expiry + a.strike + a.type).localeCompare(b.date + b.symbol + b.expiry + b.strike + b.type));
}

const q = (a: number[], p: number) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return r2(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};

export function summarizeGaps(obs: readonly GapObservation[], edges: readonly number[] = [0, 5, 20, 50, 150, Number.POSITIVE_INFINITY]): GapBucket[] {
  const out: GapBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const b = obs.filter((o) => o.close >= edges[i] && o.close < edges[i + 1]);
    const share = (f: (o: GapObservation) => boolean) => (b.length ? Math.round((b.filter(f).length / b.length) * 1000) / 1000 : null);
    out.push({
      bucket: `₹${edges[i]}–${Number.isFinite(edges[i + 1]) ? `₹${edges[i + 1]}` : '∞'}`,
      n: b.length,
      medianBuyCost: q(b.map((o) => o.buyCost), 0.5),
      medianSellCost: q(b.map((o) => o.sellCost), 0.5),
      p75Cost: q(b.flatMap((o) => [o.buyCost, o.sellCost]), 0.75),
      medianModel: q(b.map((o) => o.modelHalfSpread), 0.5),
      modelCoversBoth: share((o) => o.modelHalfSpread >= o.buyCost && o.modelHalfSpread >= o.sellCost),
      closeInsideQuote: share((o) => o.close >= o.bid && o.close <= o.ask),
    });
  }
  return out;
}
