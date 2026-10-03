/**
 * @module history/quote-recorder
 *
 * Records point-in-time bid/ask snapshots from the live option chain during
 * market hours, building a private history of real spreads (no affordable
 * vendor sells historical option bid/ask — docs/HISTORICAL_DATA_SOURCES.md).
 *
 * Each snapshot row keeps the source timestamp, our fetch time and the
 * chain's data-quality status, so later analysis can exclude stale or
 * degraded data. Missing values stay null.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DataProvider, OptionChainData } from '../data/providers/base.provider.js';
import { assessFreshness } from '../data/quality.js';
import { istDate } from '../utils/time.js';
import { dataDir } from './paths.js';

export interface QuoteSnapshotRow {
  /** Our clock when the snapshot was taken (UTC ISO). */
  recordedAt: string;
  /** Source-published timestamp (UTC ISO) or null. */
  sourceAsOf: string | null;
  quality: string;
  source: string;
  symbol: string;
  expiry: string;
  spot: number;
  strike: number;
  type: 'CE' | 'PE';
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  ltp: number | null;
  iv: number | null;
  oi: number | null;
  volume: number | null;
}

export interface RecorderConfig {
  provider: DataProvider;
  symbols: string[];
  /** Strikes on each side of ATM to record (default 10). */
  strikesEachSide?: number;
  /** Also record the next listed expiry (default true). */
  includeNextExpiry?: boolean;
  /** Only rows with this quality are written (default: FULL only). */
  acceptQuality?: Array<'FULL' | 'DEGRADED' | 'STALE'>;
  now?: () => Date;
  marketOpen: () => boolean;
  env?: Record<string, string | undefined>;
  /** Sink override (tests). Default: JSONL files under the data dir. */
  write?: (file: string, rows: QuoteSnapshotRow[]) => void;
}

export interface CycleResult {
  at: string;
  written: number;
  skipped: Array<{ symbol: string; expiry?: string; reason: string }>;
}

export class QuoteRecorder {
  /** Last source timestamp written per symbol|expiry (dedupe). */
  private readonly lastAsOf = new Map<string, string>();
  private readonly cfg: Required<Omit<RecorderConfig, 'env' | 'write'>> & Pick<RecorderConfig, 'env' | 'write'>;

  constructor(cfg: RecorderConfig) {
    if (cfg.symbols.length === 0) throw new Error('No symbols to record');
    this.cfg = {
      strikesEachSide: 10,
      includeNextExpiry: true,
      acceptQuality: ['FULL'],
      now: () => new Date(),
      ...cfg,
    };
  }

  private sink(file: string, rows: QuoteSnapshotRow[]): void {
    if (this.cfg.write) return this.cfg.write(file, rows);
    const dir = dataDir('quotes/nse-fo', this.cfg.env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  private rowsFor(chain: OptionChainData, recordedAt: string, quality: string): QuoteSnapshotRow[] {
    const spot = chain.underlyingValue;
    const strikes = chain.strikePrices;
    if (strikes.length === 0) return [];
    let atmIdx = 0;
    for (let i = 1; i < strikes.length; i++) {
      if (Math.abs(strikes[i] - spot) < Math.abs(strikes[atmIdx] - spot)) atmIdx = i;
    }
    const lo = Math.max(0, atmIdx - this.cfg.strikesEachSide);
    const keep = new Set(strikes.slice(lo, atmIdx + this.cfg.strikesEachSide + 1));
    const out: QuoteSnapshotRow[] = [];
    for (const row of chain.rows) {
      if (!keep.has(row.strikePrice)) continue;
      for (const type of ['CE', 'PE'] as const) {
        const o = row[type];
        if (!o) continue;
        out.push({
          recordedAt,
          sourceAsOf: chain.dataQuality.asOf,
          quality,
          source: chain.dataQuality.source,
          symbol: chain.symbol,
          expiry: chain.expiryDate,
          spot,
          strike: row.strikePrice,
          type,
          bid: o.bidPrice,
          ask: o.askPrice,
          bidQty: o.bidQty,
          askQty: o.askQty,
          ltp: o.lastPrice,
          iv: o.impliedVolatility,
          oi: o.openInterest,
          volume: o.totalTradedVolume,
        });
      }
    }
    return out;
  }

  /** Take one snapshot of every configured symbol. Never throws for a single symbol's failure. */
  async cycle(): Promise<CycleResult> {
    const now = this.cfg.now();
    const at = now.toISOString();
    const res: CycleResult = { at, written: 0, skipped: [] };
    if (!this.cfg.marketOpen()) {
      res.skipped.push({ symbol: '*', reason: 'market closed' });
      return res;
    }
    if (!this.cfg.provider.isReady()) await this.cfg.provider.initialize();

    for (const symbol of this.cfg.symbols) {
      let nearest: OptionChainData;
      try {
        nearest = await this.cfg.provider.getOptionChain(symbol);
      } catch (err) {
        res.skipped.push({ symbol, reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const chains = [nearest];
      if (this.cfg.includeNextExpiry && nearest.expiryDates.length > 1) {
        try {
          chains.push(await this.cfg.provider.getOptionChain(symbol, nearest.expiryDates[1]));
        } catch (err) {
          res.skipped.push({ symbol, expiry: nearest.expiryDates[1], reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
      for (const chain of chains) {
        const q = assessFreshness(chain, { now, marketOpen: true });
        if (!this.cfg.acceptQuality.includes(q.status as 'FULL')) {
          res.skipped.push({ symbol, expiry: chain.expiryDate, reason: `quality ${q.status}: ${q.reasons.join(' ')}` });
          continue;
        }
        const key = `${chain.symbol}|${chain.expiryDate}`;
        const asOf = chain.dataQuality.asOf ?? '';
        if (asOf && this.lastAsOf.get(key) === asOf) {
          res.skipped.push({ symbol, expiry: chain.expiryDate, reason: 'source timestamp unchanged since last snapshot' });
          continue;
        }
        const rows = this.rowsFor(chain, at, q.status);
        if (rows.length === 0) {
          res.skipped.push({ symbol, expiry: chain.expiryDate, reason: 'no rows near ATM' });
          continue;
        }
        this.sink(`${istDate(now)}_${chain.symbol}.jsonl`, rows);
        if (asOf) this.lastAsOf.set(key, asOf);
        res.written += rows.length;
      }
    }
    return res;
  }
}

/** Summary of a recorded spread sample (for calibrating slippage models). */
export function spreadStats(rows: QuoteSnapshotRow[]): { n: number; medianSpread: number | null; medianSpreadPct: number | null; p90SpreadPct: number | null } {
  const sp = rows
    .filter((r) => r.bid !== null && r.ask !== null && r.ask >= r.bid && r.bid > 0)
    .map((r) => ({ abs: (r.ask as number) - (r.bid as number), pct: ((r.ask as number) - (r.bid as number)) / (((r.ask as number) + (r.bid as number)) / 2) }));
  if (sp.length === 0) return { n: 0, medianSpread: null, medianSpreadPct: null, p90SpreadPct: null };
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return { n: sp.length, medianSpread: q(sp.map((x) => x.abs), 0.5), medianSpreadPct: q(sp.map((x) => x.pct), 0.5), p90SpreadPct: q(sp.map((x) => x.pct), 0.9) };
}
