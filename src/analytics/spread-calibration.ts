/**
 * Spread calibration from recorded live quotes (src/history/quote-recorder.ts).
 *
 * PRE-REGISTERED RULE (2026-10-04, before any quote was recorded). A calibrated EOD spread model
 * may replace EOD_PESSIMISTIC_V1 only when ALL hold:
 *   1. ≥ 20 distinct recording sessions, of which ≥ 1 is an expiry day and ≥ 1 had a NIFTY daily move ≥ 1 %;
 *   2. only quotes recorded 15:00–15:30 IST (the window EOD fills represent) are used;
 *   3. each premium bucket used has ≥ 200 valid two-sided quotes;
 *   4. the model's half-spread for a bucket is the OBSERVED 75th PERCENTILE half-spread of that bucket,
 *      and never below the bucket's median;
 *   5. the reference backtest is re-run with the new model as a NEW experiment; the old result stays.
 * The rule is fixed in advance so that the choice cannot follow from which spread gives the best P&L.
 *
 * AMENDMENT 2026-10-19 (before any calibration result was computed; 10 GOOD sessions recorded):
 * "session" was undefined, so a day the PC slept (2026-10-09: 2 minutes recorded, no closing
 * window) counted toward the 20. A session now counts only if its closing window (15:00–15:29 IST)
 * is GOOD: at least 24 of 30 minutes recorded for every symbol (src/history/closing-window.ts).
 * Quotes from other sessions are not used, and the expiry-day / big-move conditions must be met by
 * counted sessions. This only makes the rule stricter.
 */

import type { QuoteSnapshotRow } from '../history/quote-recorder.js';
import { closingWindowCoverage } from '../history/closing-window.js';

export const CALIBRATION_RULE = Object.freeze({
  declared: '2026-10-04',
  minSessions: 20,
  windowIst: ['15:00', '15:30'] as const,
  minQuotesPerBucket: 200,
  percentile: 0.75,
  premiumBuckets: [0, 5, 20, 50, 150, Number.POSITIVE_INFINITY] as const,
  sessionDefinition: Object.freeze({
    amended: '2026-10-19',
    minClosingWindowMinutesPerSymbol: 24,
    rule: 'A session counts only if its 15:00–15:29 IST closing window is GOOD (≥ 24 of 30 minutes recorded for every symbol); quotes from other sessions are not used.',
  }),
});

export interface BucketCalibration {
  bucket: string;
  quotes: number;
  medianHalfSpread: number | null;
  p75HalfSpread: number | null;
  p90HalfSpread: number | null;
  /** EOD_PESSIMISTIC_V1 half-spread at the bucket's median mid, for comparison. */
  v1HalfSpreadAtMedianMid: number | null;
  eligible: boolean;
}

export interface CalibrationReport {
  /** Sessions that count under the session definition (closing window GOOD). */
  sessions: number;
  /** Every day with any recorded quote. */
  sessionsRecorded: number;
  /** Days that did not count, with their closing-window rating. */
  sessionsExcluded: Array<{ date: string; rating: string; minutesCovered: number }>;
  quotesInWindow: number;
  quotesRejected: number;
  buckets: BucketCalibration[];
  ready: boolean;
  reasonsNotReady: string[];
}

function istHHMM(iso: string): string {
  const t = new Date(Date.parse(iso) + 5.5 * 3_600_000);
  return t.toISOString().slice(11, 16);
}

const q = (a: number[], p: number) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100;
};

/**
 * @param sessionFacts IST dates that were expiry days, and dates with a NIFTY close-to-close move ≥ 1 %
 *   (from the bhavcopy). Only dates that are counted sessions satisfy the conditions.
 */
export function calibrate(rows: readonly QuoteSnapshotRow[], sessionFacts: { expiryDays: ReadonlySet<string>; bigMoveDays: ReadonlySet<string> }): CalibrationReport {
  const R = CALIBRATION_RULE;
  const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const coverage = closingWindowCoverage(rows);
  const counted = new Set(coverage.filter((c) => c.rating === 'GOOD').map((c) => c.date));
  const excluded = coverage.filter((c) => !counted.has(c.date)).map((c) => ({ date: c.date, rating: c.rating, minutesCovered: c.minutesCoveredAllSymbols }));
  const sessions = counted;
  let rejected = 0;
  const valid: Array<{ mid: number; half: number }> = [];
  for (const r of rows) {
    if (!counted.has(istDay(r.recordedAt))) continue;
    const t = istHHMM(r.recordedAt);
    if (t < R.windowIst[0] || t > R.windowIst[1]) continue;
    if (r.bid === null || r.ask === null || !(r.bid > 0) || !(r.ask >= r.bid) || r.quality !== 'FULL') { rejected++; continue; }
    valid.push({ mid: (r.bid + r.ask) / 2, half: (r.ask - r.bid) / 2 });
  }
  const buckets: BucketCalibration[] = [];
  for (let i = 0; i < R.premiumBuckets.length - 1; i++) {
    const lo = R.premiumBuckets[i], hi = R.premiumBuckets[i + 1];
    const b = valid.filter((v) => v.mid >= lo && v.mid < hi);
    const medMid = q(b.map((v) => v.mid), 0.5);
    buckets.push({
      bucket: `₹${lo}–${Number.isFinite(hi) ? `₹${hi}` : '∞'}`,
      quotes: b.length,
      medianHalfSpread: q(b.map((v) => v.half), 0.5),
      p75HalfSpread: q(b.map((v) => v.half), R.percentile),
      p90HalfSpread: q(b.map((v) => v.half), 0.9),
      v1HalfSpreadAtMedianMid: medMid === null ? null : Math.round(Math.max(0.1, 0.02 * medMid) * 100) / 100,
      eligible: b.length >= R.minQuotesPerBucket,
    });
  }
  const reasons: string[] = [];
  if (sessions.size < R.minSessions) reasons.push(`${sessions.size} counted session(s) (closing window GOOD); ${R.minSessions} required`);
  if (![...sessions].some((d) => sessionFacts.expiryDays.has(d))) reasons.push('no counted expiry-day session');
  if (![...sessions].some((d) => sessionFacts.bigMoveDays.has(d))) reasons.push('no counted session with a NIFTY move ≥ 1 %');
  if (!buckets.some((b) => b.eligible)) reasons.push(`no premium bucket has ${R.minQuotesPerBucket} valid quotes in the 15:00–15:30 window`);
  return { sessions: sessions.size, sessionsRecorded: coverage.length, sessionsExcluded: excluded, quotesInWindow: valid.length, quotesRejected: rejected, buckets, ready: reasons.length === 0, reasonsNotReady: reasons };
}
