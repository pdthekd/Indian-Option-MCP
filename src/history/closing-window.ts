/**
 * Closing-window coverage: how much of the 15:00–15:29 IST window (the quotes execution
 * calibration uses) was actually recorded on a session.
 *
 * A minute counts as covered for a symbol when at least one row for that symbol was recorded in it.
 * Informational only: it tells you which sessions are thin; the pre-registered calibration rule
 * (src/analytics/spread-calibration.ts) is unchanged.
 */

import type { QuoteSnapshotRow } from './quote-recorder.js';

export const CLOSING_WINDOW = { startIst: '15:00', endIst: '15:29', minutes: 30 } as const;

export interface ClosingWindowCoverage {
  date: string;
  /** Minutes (of 30) with at least one row for EVERY symbol seen that day. */
  minutesCoveredAllSymbols: number;
  /** Minutes (of 30) with at least one row, per symbol. */
  minutesCoveredBySymbol: Record<string, number>;
  /** Two-sided quotes (bid > 0, ask ≥ bid, FULL) recorded in the window. */
  twoSidedQuotes: number;
  /** GOOD ≥ 24 of 30 minutes for every symbol; PARTIAL ≥ 12; POOR below; NONE when nothing was recorded. */
  rating: 'GOOD' | 'PARTIAL' | 'POOR' | 'NONE';
  /** Uncovered minutes (HH:MM IST), for every symbol combined. */
  missingMinutes: string[];
}

const IST_MS = 5.5 * 3_600_000;

function windowMinutes(): string[] {
  const out: string[] = [];
  for (let m = 15 * 60; m < 15 * 60 + CLOSING_WINDOW.minutes; m++) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}

/** Coverage for each IST date present in `rows`. */
export function closingWindowCoverage(rows: readonly QuoteSnapshotRow[]): ClosingWindowCoverage[] {
  const window = windowMinutes();
  const inWindow = new Set(window);
  const byDate = new Map<string, { symbols: Set<string>; minutes: Map<string, Set<string>>; twoSided: number }>();
  for (const r of rows) {
    const t = new Date(Date.parse(r.recordedAt) + IST_MS).toISOString();
    const date = t.slice(0, 10), hhmm = t.slice(11, 16);
    const d = byDate.get(date) ?? { symbols: new Set<string>(), minutes: new Map<string, Set<string>>(), twoSided: 0 };
    byDate.set(date, d);
    d.symbols.add(r.symbol);
    if (!inWindow.has(hhmm)) continue;
    const m = d.minutes.get(r.symbol) ?? new Set<string>();
    d.minutes.set(r.symbol, m);
    m.add(hhmm);
    if (r.quality === 'FULL' && r.bid !== null && r.ask !== null && r.bid > 0 && r.ask >= r.bid) d.twoSided++;
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => {
    const symbols = [...d.symbols].sort();
    const bySymbol = Object.fromEntries(symbols.map((s) => [s, d.minutes.get(s)?.size ?? 0]));
    const all = window.filter((m) => symbols.every((s) => d.minutes.get(s)?.has(m)));
    const worst = symbols.length ? Math.min(...symbols.map((s) => bySymbol[s])) : 0;
    const rating: ClosingWindowCoverage['rating'] =
      worst === 0 && d.twoSided === 0 ? 'NONE' : worst >= 24 ? 'GOOD' : worst >= 12 ? 'PARTIAL' : 'POOR';
    return {
      date,
      minutesCoveredAllSymbols: all.length,
      minutesCoveredBySymbol: bySymbol,
      twoSidedQuotes: d.twoSided,
      rating,
      missingMinutes: window.filter((m) => !all.includes(m)),
    };
  });
}
