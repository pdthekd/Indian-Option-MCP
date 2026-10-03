/**
 * @module data/quality
 * Helpers that keep "missing" distinct from "zero" and classify chain quality.
 */

import type {
  DataQuality,
  DataQualityStatus,
  OptionChainData,
  OptionChainRow,
} from './providers/base.provider.js';
import { parseSourceTimestamp } from '../utils/time.js';

/** Finite number or null. Never coerces missing values to 0. */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Strictly positive finite number or null. Use for fields where the source
 * publishes 0 to mean "none" (LTP of an untraded contract, empty bid/ask, IV
 * of an untraded strike).
 */
export function positive(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/** Sum a nullable field across rows; null if every value is null. */
export function sumField(
  rows: OptionChainRow[],
  side: 'CE' | 'PE',
  field: 'openInterest' | 'totalTradedVolume' | 'changeinOpenInterest',
): number | null {
  let total = 0;
  let seen = false;
  for (const r of rows) {
    const v = r[side]?.[field];
    if (typeof v === 'number') {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Default maximum age of chain data during market hours. */
export const DEFAULT_MAX_AGE_SECONDS = 120;

export interface FreshnessContext {
  now: Date;
  marketOpen: boolean;
  maxAgeSeconds?: number;
}

const RANK: Record<DataQualityStatus, number> = { FULL: 0, DEGRADED: 1, STALE: 2, UNAVAILABLE: 3 };

function worse(a: DataQualityStatus, b: DataQualityStatus): DataQualityStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Re-evaluate quality at read time (cached data ages). Returns a NEW
 * DataQuality; never mutates the cached chain.
 */
export function assessFreshness(
  chain: OptionChainData,
  ctx: FreshnessContext,
): DataQuality & { ageSeconds: number | null } {
  const dq = chain.dataQuality;
  const reasons = [...dq.reasons];
  let status = dq.status;
  const asOf = dq.asOf ? new Date(dq.asOf) : parseSourceTimestamp(chain.timestamp);
  const ageSeconds = asOf ? Math.max(0, (ctx.now.getTime() - asOf.getTime()) / 1000) : null;

  if (chain.rows.length === 0) {
    status = 'UNAVAILABLE';
    reasons.push('No option rows for the resolved expiry.');
  }
  if (!(chain.underlyingValue > 0)) {
    status = 'UNAVAILABLE';
    reasons.push('Underlying price unavailable.');
  }
  if (ageSeconds === null) {
    status = worse(status, 'STALE');
    reasons.push('Source did not publish a timestamp; data age unknown.');
  } else if (!ctx.marketOpen) {
    status = worse(status, 'STALE');
    reasons.push('Market is not open; values are the last published snapshot.');
  } else if (ageSeconds > (ctx.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS)) {
    status = worse(status, 'STALE');
    reasons.push(`Data is ${Math.round(ageSeconds)}s old (limit ${ctx.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS}s).`);
  }
  return { ...dq, status, reasons, ageSeconds };
}

/** One-line human summary for tool output. */
export function qualityBanner(q: DataQuality & { ageSeconds?: number | null }): string {
  const parts = [`DATA QUALITY: ${q.status} (source: ${q.source})`];
  if (q.ageSeconds !== undefined && q.ageSeconds !== null) parts.push(`age ${Math.round(q.ageSeconds)}s`);
  if (q.unavailableFields.length) parts.push(`unavailable: ${q.unavailableFields.join(', ')}`);
  const lines = [parts.join(' | ')];
  for (const r of q.reasons) lines.push(`  - ${r}`);
  return lines.join('\n');
}

/** Format a nullable number for display; missing values print as "n/a". */
export function fmt(v: number | null | undefined, digits = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}
