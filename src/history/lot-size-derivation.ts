/**
 * @module history/lot-size-derivation
 *
 * Derives lot-size history from NSE bhavcopy rows. For each symbol and trade
 * date, if every listed contract (options and futures, all expiries) has the
 * same lot size the date is "uniform"; otherwise it is a transition date
 * (revisions roll through contract by contract). Consecutive uniform dates
 * with the same size form a period.
 */

export interface LotObservation {
  tradeDate: string;
  symbol: string;
  lotSize: number;
}

/** [tradeFrom, tradeTo (null = still current at the end of the data), lotSize] */
export type LotPeriod = [string, string | null, number];

export interface DerivedLotHistory {
  /** First and last trade dates in the input. */
  dataFrom: string;
  dataTo: string;
  tradeDates: number;
  periods: Record<string, LotPeriod[]>;
  /** Trade dates on which a symbol's contracts had different lot sizes. */
  transitions: Record<string, string[]>;
}

export function deriveLotHistory(rows: Iterable<LotObservation>): DerivedLotHistory {
  const bySymbol = new Map<string, Map<string, Set<number>>>();
  const allDates = new Set<string>();
  for (const r of rows) {
    if (!(r.lotSize > 0)) continue;
    allDates.add(r.tradeDate);
    let dates = bySymbol.get(r.symbol);
    if (!dates) { dates = new Map(); bySymbol.set(r.symbol, dates); }
    let sizes = dates.get(r.tradeDate);
    if (!sizes) { sizes = new Set(); dates.set(r.tradeDate, sizes); }
    sizes.add(r.lotSize);
  }
  const sortedDates = [...allDates].sort();
  if (sortedDates.length === 0) throw new Error('No lot-size observations');
  const dataTo = sortedDates[sortedDates.length - 1];

  const periods: Record<string, LotPeriod[]> = {};
  const transitions: Record<string, string[]> = {};
  for (const symbol of [...bySymbol.keys()].sort()) {
    const dates = bySymbol.get(symbol)!;
    const out: LotPeriod[] = [];
    const trans: string[] = [];
    let cur: LotPeriod | null = null;
    for (const d of [...dates.keys()].sort()) {
      const sizes = dates.get(d)!;
      if (sizes.size !== 1) {
        trans.push(d);
        if (cur) { out.push(cur); cur = null; }
        continue;
      }
      const lot = [...sizes][0];
      if (cur && cur[2] === lot) cur[1] = d;
      else {
        if (cur) out.push(cur);
        cur = [d, d, lot];
      }
    }
    if (cur) out.push(cur);
    // The symbol's last period is "current" only if it reaches the last data date.
    const last = out[out.length - 1];
    if (last && last[1] === dataTo) last[1] = null;
    periods[symbol] = out;
    if (trans.length) transitions[symbol] = trans;
  }
  return { dataFrom: sortedDates[0], dataTo, tradeDates: sortedDates.length, periods, transitions };
}

/** Render the derived history as a TypeScript module (deterministic output). */
export function renderLotHistoryModule(h: DerivedLotHistory, sourceNote: string): string {
  const lines: string[] = [];
  lines.push('// GENERATED FILE — do not edit by hand.');
  lines.push('// Regenerate: npm run build && node dist/derive-lot-sizes-cli.mjs');
  lines.push(`// Source: ${sourceNote}`);
  lines.push('');
  lines.push("import type { LotPeriod } from '../../history/lot-size-derivation.js';");
  lines.push('');
  lines.push(`export const LOT_HISTORY_META = ${JSON.stringify({ dataFrom: h.dataFrom, dataTo: h.dataTo, tradeDates: h.tradeDates, symbols: Object.keys(h.periods).length })} as const;`);
  lines.push('');
  lines.push('/** symbol → [tradeFrom, tradeTo | null (current), lotSize][] */');
  lines.push('export const LOT_HISTORY: Readonly<Record<string, readonly LotPeriod[]>> = {');
  for (const s of Object.keys(h.periods).sort()) {
    lines.push(`  ${JSON.stringify(s)}: ${JSON.stringify(h.periods[s])},`);
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}
