/**
 * Closing-window coverage: how much of the 15:00–15:29 IST window (the quotes execution
 * calibration uses) was actually recorded on a session.
 *
 * A minute counts as covered for a symbol when at least one row for that symbol was recorded in it.
 * Informational only: it tells you which sessions are thin; the pre-registered calibration rule
 * (src/analytics/spread-calibration.ts) is unchanged.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** IST 15:00–15:30 is 09:30–10:00 UTC (fixed offset, no DST). */
const WINDOW_UTC = ['09:30', '10:00'] as const;

/**
 * Read recorded quote files, parsing only rows stamped 15:00–15:30 IST (the only rows calibration,
 * coverage and close-gap use; about 8 % of a day). `recorded` lists every recorded day and its
 * symbols from the file names, so a day with nothing in the window is still reported (as NONE).
 */
export function readClosingWindowQuotes(dir: string): { rows: QuoteSnapshotRow[]; recorded: Map<string, string[]> } {
  const rows: QuoteSnapshotRow[] = [];
  const recorded = new Map<string, string[]>();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}_.+\.jsonl$/.test(f)).sort() : [];
  for (const f of files) {
    const date = f.slice(0, 10);
    recorded.set(date, [...(recorded.get(date) ?? []), f.slice(11, -6)]);
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const t = /"recordedAt":"\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(l)?.[1];
      if (t !== undefined && t >= WINDOW_UTC[0] && t <= WINDOW_UTC[1]) rows.push(JSON.parse(l) as QuoteSnapshotRow);
    }
  }
  return { rows, recorded };
}

/**
 * Coverage for each IST date present in `rows`, plus every date in `recorded` (date → symbols
 * recorded that day), so a symbol with no rows in the window counts as 0 minutes.
 */
export function closingWindowCoverage(rows: readonly QuoteSnapshotRow[], recorded?: ReadonlyMap<string, readonly string[]>): ClosingWindowCoverage[] {
  const window = windowMinutes();
  const inWindow = new Set(window);
  const byDate = new Map<string, { symbols: Set<string>; minutes: Map<string, Set<string>>; twoSided: number }>();
  for (const [date, symbols] of recorded ?? []) byDate.set(date, { symbols: new Set(symbols), minutes: new Map(), twoSided: 0 });
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
