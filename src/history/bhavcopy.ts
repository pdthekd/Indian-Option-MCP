/**
 * @module history/bhavcopy
 *
 * NSE F&O daily bhavcopy (UDiFF "Common Bhavcopy Final" format, published
 * from 2024-07-08). End-of-day reference data for every listed contract:
 * OHLC, close, settlement price, open interest, volume, lot size,
 * underlying price.
 *
 * NOT intraday and NO bid/ask. See docs/HISTORICAL_DATA_SOURCES.md.
 *
 * Units (verified on the 2025-05-09 file):
 *   openInterest            UNITS (shares/index units), not contracts
 *   volumeContracts         CONTRACTS
 *   notionalTurnover        ₹ notional; for options (strike + premium) × qty
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from './zip.js';
import { dataDir } from './paths.js';
import { lotSizeFor, observationKey } from '../data/constants/lot-sizes.js';
import type {
  HistoricalChainSnapshot, HistoricalMarketDataProvider, HistoricalOptionQuote,
} from '../backtest/historical-data.js';

/** The only host this module contacts. */
export const BHAVCOPY_HOST = 'https://nsearchives.nseindia.com';
/** First trading date published in UDiFF format. */
export const UDIFF_START = '2024-07-08';

export type InstrumentType = 'IDX_OPT' | 'IDX_FUT' | 'STK_OPT' | 'STK_FUT';
const TYPE_MAP: Record<string, InstrumentType> = { IDO: 'IDX_OPT', IDF: 'IDX_FUT', STO: 'STK_OPT', STF: 'STK_FUT' };

/**
 * Version of the normalized JSONL format. Bump whenever parseBhavcopyCsv output changes; the data
 * version of a backtest records it, because the same raw files then normalize to different bytes.
 *  1: initial format
 *  2: adds instrumentId (NSE FinInstrmId; stable when NSE relabels a contract's expiry)
 */
export const NORMALIZER_VERSION = 2;

export interface BhavRecord {
  tradeDate: string;
  /** NSE FinInstrmId: the contract's identity. Unlike `expiry`, it does not change if NSE relabels the expiry. */
  instrumentId?: string | null;
  symbol: string;
  instrumentType: InstrumentType;
  expiry: string;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  lastPrice: number | null;
  previousClose: number | null;
  settlementPrice: number | null;
  underlyingPrice: number | null;
  openInterest: number | null;
  changeInOpenInterest: number | null;
  volumeContracts: number | null;
  notionalTurnover: number | null;
  trades: number | null;
  lotSize: number | null;
}

/** Download URL for a trade date (UDiFF only). */
export function bhavcopyUrl(tradeDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`tradeDate must be YYYY-MM-DD (got "${tradeDate}")`);
  if (tradeDate < UDIFF_START) {
    throw new Error(`Only the UDiFF format (from ${UDIFF_START}) is supported; ${tradeDate} uses the legacy format.`);
  }
  return `${BHAVCOPY_HOST}/content/fo/BhavCopy_NSE_FO_0_0_0_${tradeDate.replace(/-/g, '')}_F_0000.csv.zip`;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const REQUIRED = ['TradDt', 'FinInstrmTp', 'TckrSymb', 'XpryDt', 'StrkPric', 'OptnTp', 'OpnPric', 'HghPric', 'LwPric',
  'ClsPric', 'SttlmPric', 'OpnIntrst', 'TtlTradgVol', 'NewBrdLotQty', 'UndrlygPric'];

/** Parse UDiFF bhavcopy CSV text. Throws if the header is not the expected format. */
export function parseBhavcopyCsv(text: string): BhavRecord[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('Bhavcopy CSV is empty');
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`Unexpected bhavcopy format; missing columns: ${missing.join(', ')}`);
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const out: BhavRecord[] = [];
  for (let li = 1; li < lines.length; li++) {
    const c = splitCsvLine(lines[li]);
    const g = (k: string) => c[idx[k]]?.trim();
    const type = TYPE_MAP[g('FinInstrmTp') ?? ''];
    if (!type) continue; // unknown instrument class: skip, never guess
    const opt = g('OptnTp');
    out.push({
      tradeDate: g('TradDt') ?? '',
      instrumentId: idx.FinInstrmId !== undefined ? (g('FinInstrmId') || null) : null,
      symbol: g('TckrSymb') ?? '',
      instrumentType: type,
      expiry: g('XpryDt') ?? '',
      strike: num(g('StrkPric')),
      optionType: opt === 'CE' || opt === 'PE' ? opt : null,
      open: num(g('OpnPric')),
      high: num(g('HghPric')),
      low: num(g('LwPric')),
      close: num(g('ClsPric')),
      lastPrice: idx.LastPric !== undefined ? num(g('LastPric')) : null,
      previousClose: idx.PrvsClsgPric !== undefined ? num(g('PrvsClsgPric')) : null,
      settlementPrice: num(g('SttlmPric')),
      underlyingPrice: num(g('UndrlygPric')),
      openInterest: num(g('OpnIntrst')),
      changeInOpenInterest: idx.ChngInOpnIntrst !== undefined ? num(g('ChngInOpnIntrst')) : null,
      volumeContracts: num(g('TtlTradgVol')),
      notionalTurnover: idx.TtlTrfVal !== undefined ? num(g('TtlTrfVal')) : null,
      trades: idx.TtlNbOfTxsExctd !== undefined ? num(g('TtlNbOfTxsExctd')) : null,
      lotSize: num(g('NewBrdLotQty')),
    });
  }
  return out;
}

export interface ManifestEntry {
  tradeDate: string;
  status: 'OK' | 'NO_FILE' | 'ERROR';
  url: string;
  sha256?: string;
  bytes?: number;
  rows?: number;
  keptRows?: number;
  fetchedAt: string;
  detail?: string;
  /** 'cache' when the stored raw zip was re-normalized without a download. */
  source?: 'cache' | 'network';
  normalizerVersion?: number;
}

export interface FetchOptions {
  /** Underlyings to keep in the normalised extract (raw zip is always kept). */
  symbols?: string[];
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  timeoutMs?: number;
}

export const DEFAULT_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'];

function storeDirs(env?: Record<string, string | undefined>) {
  const root = dataDir('bhavcopy/nse-fo', env);
  const raw = join(root, 'raw');
  const norm = join(root, 'normalized');
  mkdirSync(raw, { recursive: true });
  mkdirSync(norm, { recursive: true });
  return { root, raw, norm, manifest: join(root, 'manifest.jsonl') };
}

/**
 * Download (once) and normalise one trade date. Raw files are immutable:
 * an existing raw zip is never overwritten. Returns the manifest entry.
 */
export async function fetchBhavcopy(tradeDate: string, opts: FetchOptions = {}): Promise<ManifestEntry> {
  const url = bhavcopyUrl(tradeDate);
  const now = opts.now ?? (() => new Date());
  const d = storeDirs(opts.env);
  const rawPath = join(d.raw, `${tradeDate}.csv.zip`);
  const normPath = join(d.norm, `${tradeDate}.jsonl`);
  const symbols = new Set((opts.symbols ?? DEFAULT_SYMBOLS).map((s) => s.toUpperCase()));
  const record = (e: ManifestEntry) => { appendFileSync(d.manifest, JSON.stringify(e) + '\n'); return e; };

  let buf: Buffer;
  const cached = existsSync(rawPath);
  if (cached) {
    buf = readFileSync(rawPath);
  } else {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; options-hq-research/1.0)' },
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (res.status === 404) {
        return record({ tradeDate, status: 'NO_FILE', url, fetchedAt: now().toISOString(), detail: 'HTTP 404 (holiday, weekend, or not yet published)' });
      }
      if (!res.ok) {
        return record({ tradeDate, status: 'ERROR', url, fetchedAt: now().toISOString(), detail: `HTTP ${res.status}` });
      }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return record({ tradeDate, status: 'ERROR', url, fetchedAt: now().toISOString(), detail: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(t);
    }
  }

  try {
    const entries = readZip(buf);
    const csv = entries.find((e) => e.name.toLowerCase().endsWith('.csv'));
    if (!csv) throw new Error('ZIP contains no CSV');
    const rows = parseBhavcopyCsv(csv.data.toString('utf8'));
    if (rows.some((r) => r.tradeDate !== tradeDate)) throw new Error('File contains rows for a different trade date');
    const kept = rows.filter((r) => symbols.has(r.symbol));
    if (!existsSync(rawPath)) writeFileSync(rawPath, buf, { flag: 'wx' });
    writeFileSync(normPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return record({
      tradeDate, status: 'OK', url, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length,
      rows: rows.length, keptRows: kept.length, fetchedAt: now().toISOString(),
      source: cached ? 'cache' : 'network', normalizerVersion: NORMALIZER_VERSION,
    });
  } catch (err) {
    return record({ tradeDate, status: 'ERROR', url, fetchedAt: now().toISOString(), detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Load the normalised extract for a date (null if not downloaded). */
export function loadBhavcopy(tradeDate: string, env?: Record<string, string | undefined>): BhavRecord[] | null {
  const p = join(storeDirs(env).norm, `${tradeDate}.jsonl`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as BhavRecord);
}

export interface LotSizeCheck {
  symbol: string;
  expiry: string;
  tradeDate: string;
  bhavcopyLotSize: number;
  modelLotSize: number | null;
  /** TRANSITION = model defers to bhavcopy for this date (expected, not an error). */
  status: 'MATCH' | 'MISMATCH' | 'TRANSITION';
  detail?: string;
}

/** Compare bhavcopy lot sizes with the trade-date model (without using the observations themselves). */
export function checkLotSizes(records: BhavRecord[]): LotSizeCheck[] {
  const seen = new Map<string, LotSizeCheck>();
  for (const r of records) {
    if (r.lotSize === null) continue;
    const key = `${r.symbol}|${r.expiry}|${r.tradeDate}`;
    if (seen.has(key)) continue;
    try {
      const m = lotSizeFor(r.symbol, r.expiry, r.tradeDate);
      seen.set(key, { symbol: r.symbol, expiry: r.expiry, tradeDate: r.tradeDate, bhavcopyLotSize: r.lotSize, modelLotSize: m.lotSize, status: m.lotSize === r.lotSize ? 'MATCH' : 'MISMATCH' });
    } catch (err) {
      seen.set(key, { symbol: r.symbol, expiry: r.expiry, tradeDate: r.tradeDate, bhavcopyLotSize: r.lotSize, modelLotSize: null, status: 'TRANSITION', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return [...seen.values()];
}

/** Per-contract lot-size observations for lotSizeFor(…, observations). */
export function lotSizeObservations(records: BhavRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) if (r.lotSize !== null) m.set(observationKey(r.symbol, r.expiry, r.tradeDate), r.lotSize);
  return m;
}

/**
 * Bhavcopy is published after the close. For point-in-time use, its data is
 * treated as KNOWN only from 20:00 IST on the trade date (14:30 UTC) — never
 * at 15:30, which would leak settlement prices into same-day decisions.
 */
export function bhavcopyKnownAt(tradeDate: string): Date {
  return new Date(`${tradeDate}T14:30:00Z`);
}

/**
 * End-of-day HistoricalMarketDataProvider backed by stored bhavcopy files.
 * Quotes carry close as LTP and NULL bid/ask (not available). Wrap with
 * PointInTimeGuard in back-tests.
 */
export class BhavcopyHistoricalProvider implements HistoricalMarketDataProvider {
  readonly name = 'nse-bhavcopy-eod';
  constructor(private readonly tradeDates: string[], private readonly env?: Record<string, string | undefined>) {}

  /** Latest stored trade date whose data was known at `asOf`. */
  private latestDate(asOf: Date): string {
    const ds = this.tradeDates.filter((d) => bhavcopyKnownAt(d) <= asOf).sort();
    const d = ds[ds.length - 1];
    if (!d) throw new Error(`No bhavcopy known as of ${asOf.toISOString()}`);
    return d;
  }

  private rows(date: string): BhavRecord[] {
    const r = loadBhavcopy(date, this.env);
    if (!r) throw new Error(`Bhavcopy for ${date} not downloaded`);
    return r;
  }

  async listedExpiries(underlying: string, asOf: Date): Promise<string[]> {
    const date = this.latestDate(asOf);
    return [...new Set(this.rows(date).filter((r) => r.symbol === underlying && r.optionType).map((r) => r.expiry))].sort();
  }

  async chainAt(underlying: string, expiry: string, asOf: Date): Promise<HistoricalChainSnapshot> {
    const date = this.latestDate(asOf);
    const known = bhavcopyKnownAt(date);
    const rows = this.rows(date).filter((r) => r.symbol === underlying && r.expiry === expiry && r.optionType);
    if (rows.length === 0) throw new Error(`No ${underlying} ${expiry} options in bhavcopy ${date}`);
    const lot = rows.find((r) => r.lotSize !== null)?.lotSize;
    const und = rows.find((r) => r.underlyingPrice !== null)?.underlyingPrice;
    if (!lot || !und) throw new Error(`Bhavcopy ${date} lacks lot size or underlying price for ${underlying}`);
    const quotes: HistoricalOptionQuote[] = rows.map((r) => ({
      symbol: `${r.symbol}|${r.expiry}|${r.strike}|${r.optionType}`,
      underlying: r.symbol,
      expiry: r.expiry,
      strike: r.strike as number,
      optionType: r.optionType as 'CE' | 'PE',
      bid: null,
      ask: null,
      ltp: r.close,
      volume: r.volumeContracts,
      openInterest: r.openInterest,
      impliedVolatility: null,
      timestamp: known,
    }));
    return { underlying, underlyingPrice: und, underlyingTimestamp: known, expiry, quotes, lotSize: lot, asOf: known };
  }

  /** Final settlement price of the index on an expiry day (see finalSettlementPrice). */
  async settlementPrice(underlying: string, expiry: string): Promise<number> {
    return finalSettlementPrice(this.rows(expiry), underlying, expiry);
  }
}

/**
 * Final settlement price for index options expiring on `expiry`, read from
 * that day's bhavcopy. On expiry day NSE reports the underlying's final
 * settlement price in `SttlmPric` of every expiring option row (verified on
 * 2025-05-15 and 2026-09-29: equal to `UndrlygPric`). Works for weekly
 * expiries, which have no expiring future. Throws if rows disagree or are
 * missing — never approximates.
 */
export function finalSettlementPrice(expiryDayRows: BhavRecord[], underlying: string, expiry: string): number {
  const rows = expiryDayRows.filter((r) => r.tradeDate === expiry && r.symbol === underlying && r.expiry === expiry && r.optionType);
  const values = new Set(rows.map((r) => r.settlementPrice).filter((v): v is number => v !== null));
  if (rows.length === 0 || values.size === 0) throw new Error(`No ${underlying} options expiring ${expiry} in that day's bhavcopy`);
  if (values.size !== 1) throw new Error(`${underlying} ${expiry}: expiring option rows disagree on settlement price (${[...values].join(', ')})`);
  return [...values][0];
}
