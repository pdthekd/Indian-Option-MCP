/**
 * Bhavcopy ingester, ZIP reader, data-dir guard and quote recorder.
 * Hermetic: synthetic data, fake fetch, temporary directories.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { readZip } from '../history/zip.js';
import { dataRoot } from '../history/paths.js';
import {
  bhavcopyUrl, parseBhavcopyCsv, fetchBhavcopy, loadBhavcopy, checkLotSizes, lotSizeObservations, BhavcopyHistoricalProvider, bhavcopyKnownAt,
} from '../history/bhavcopy.js';
import { PointInTimeGuard, LookAheadError } from '../backtest/historical-data.js';
import { QuoteRecorder, spreadStats, type QuoteSnapshotRow } from '../history/quote-recorder.js';
import { BaseProvider, type OptionChainData } from '../data/providers/base.provider.js';

/** Build a single-entry deflate ZIP (test helper). */
function makeZip(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const comp = deflateRawSync(data);
  const nameB = Buffer.from(name);
  const crc = crc32(data);
  const loc = Buffer.alloc(30);
  loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8);
  loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nameB.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameB.length, 28);
  cen.writeUInt32LE(0, 42);
  const cenOff = loc.length + nameB.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cen.length + nameB.length, 12); eocd.writeUInt32LE(cenOff, 16);
  return Buffer.concat([loc, nameB, comp, cen, nameB, eocd]);
}

const HEADER = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4';
const row = (date: string, tp: string, sym: string, exp: string, strike: string, opt: string, close: string, settle: string, oi: string, lot: string, und = '25000.00') =>
  `${date},${date},FO,NSE,${tp},1,,${sym},,${exp},${exp},${strike},${opt},${sym} X,1,2,0.5,${close},${close},1,${und},${settle},${oi},0,100,1000,10,F1,${lot},,,,,`;
function csvFor(date: string, lot = '65'): string {
  return [
    HEADER,
    row(date, 'IDO', 'NIFTY', '2026-10-06', '25000.00', 'CE', '120.50', '120.50', '650000', lot),
    row(date, 'IDO', 'NIFTY', '2026-10-06', '25000.00', 'PE', '95.00', '95.00', '585000', lot),
    row(date, 'IDF', 'NIFTY', '2026-10-27', '', '', '25100.00', '25100.00', '1300000', lot),
    row(date, 'STO', 'RELIANCE', '2026-10-27', '1400.00', 'CE', '20.00', '20.00', '500', '500'),
    row(date, 'XYZ', 'WEIRD', '2026-10-27', '', '', '1', '1', '1', '1'),
  ].join('\r\n') + '\r\n';
}

let env: Record<string, string>;
beforeEach(() => { env = { OPTIONS_HQ_DATA_DIR: mkdtempSync(join(tmpdir(), 'ohq-data-')) }; });

describe('data directory guard', () => {
  it('refuses a data directory inside the working directory', () => {
    expect(() => dataRoot({ OPTIONS_HQ_DATA_DIR: join(process.cwd(), 'data') })).toThrow(/inside the working directory/);
    expect(() => dataRoot({ OPTIONS_HQ_DATA_DIR: process.cwd() })).toThrow();
    expect(dataRoot(env)).toBe(env.OPTIONS_HQ_DATA_DIR);
  });
});

describe('ZIP reader', () => {
  it('reads a deflate entry and rejects non-zip input', () => {
    const z = readZip(makeZip('a.csv', 'hello,world\n'));
    expect(z[0].name).toBe('a.csv');
    expect(z[0].data.toString()).toBe('hello,world\n');
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow();
  });
});

describe('bhavcopy parsing', () => {
  it('builds the UDiFF URL and refuses legacy dates', () => {
    expect(bhavcopyUrl('2025-05-09')).toBe('https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20250509_F_0000.csv.zip');
    expect(() => bhavcopyUrl('2024-07-05')).toThrow(/legacy/);
  });
  it('parses typed records, keeps units explicit, skips unknown instrument types', () => {
    const r = parseBhavcopyCsv(csvFor('2026-10-05'));
    expect(r).toHaveLength(4);
    const ce = r.find((x) => x.optionType === 'CE')!;
    expect(ce).toMatchObject({ symbol: 'NIFTY', instrumentType: 'IDX_OPT', strike: 25000, settlementPrice: 120.5, openInterest: 650000, lotSize: 65, volumeContracts: 100 });
    const fut = r.find((x) => x.instrumentType === 'IDX_FUT')!;
    expect(fut.strike).toBeNull();
    expect(fut.optionType).toBeNull();
  });
  it('rejects an unexpected format', () => {
    expect(() => parseBhavcopyCsv('a,b,c\n1,2,3\n')).toThrow(/missing columns/);
  });
});

describe('bhavcopy download and storage', () => {
  const fakeFetch = (status: number, body?: Buffer) => (async () =>
    new Response(body ?? null, { status })) as unknown as typeof fetch;

  it('stores raw zip + normalised extract outside the repo and records a manifest', async () => {
    const e = await fetchBhavcopy('2026-10-05', { env, fetchImpl: fakeFetch(200, makeZip('x.csv', csvFor('2026-10-05'))), symbols: ['NIFTY'] });
    expect(e.status).toBe('OK');
    expect(e.rows).toBe(4);
    expect(e.keptRows).toBe(3);
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    const root = join(env.OPTIONS_HQ_DATA_DIR, 'bhavcopy', 'nse-fo');
    expect(existsSync(join(root, 'raw', '2026-10-05.csv.zip'))).toBe(true);
    expect(loadBhavcopy('2026-10-05', env)).toHaveLength(3);
    expect(readFileSync(join(root, 'manifest.jsonl'), 'utf8')).toContain('"status":"OK"');
  });
  it('re-uses the stored raw file instead of downloading again', async () => {
    await fetchBhavcopy('2026-10-05', { env, fetchImpl: fakeFetch(200, makeZip('x.csv', csvFor('2026-10-05'))) });
    let called = false;
    const spy = (async () => { called = true; return new Response(null, { status: 500 }); }) as unknown as typeof fetch;
    const e = await fetchBhavcopy('2026-10-05', { env, fetchImpl: spy });
    expect(called).toBe(false);
    expect(e.status).toBe('OK');
  });
  it('404 → NO_FILE, other failures → ERROR, garbage → ERROR (nothing stored)', async () => {
    expect((await fetchBhavcopy('2026-10-06', { env, fetchImpl: fakeFetch(404) })).status).toBe('NO_FILE');
    expect((await fetchBhavcopy('2026-10-07', { env, fetchImpl: fakeFetch(503) })).status).toBe('ERROR');
    const bad = await fetchBhavcopy('2026-10-08', { env, fetchImpl: fakeFetch(200, Buffer.from('<html>blocked</html>')) });
    expect(bad.status).toBe('ERROR');
    expect(existsSync(join(env.OPTIONS_HQ_DATA_DIR, 'bhavcopy', 'nse-fo', 'raw', '2026-10-08.csv.zip'))).toBe(false);
  });
  it('rejects a file whose rows belong to another date', async () => {
    const e = await fetchBhavcopy('2026-10-09', { env, fetchImpl: fakeFetch(200, makeZip('x.csv', csvFor('2026-10-05'))) });
    expect(e.status).toBe('ERROR');
    expect(e.detail).toMatch(/different trade date/);
  });
});

describe('lot-size cross-check', () => {
  it('flags mismatches against the versioned table', () => {
    const ok = checkLotSizes(parseBhavcopyCsv(csvFor('2026-10-05', '65')).filter((r) => r.symbol === 'NIFTY'));
    expect(ok.every((c) => c.status === 'MATCH')).toBe(true);
    const bad = checkLotSizes(parseBhavcopyCsv(csvFor('2026-10-05', '75')).filter((r) => r.instrumentType === 'IDX_OPT'));
    expect(bad[0].status).toBe('MISMATCH');
    // A date inside a transition window is reported as TRANSITION, not as an error.
    const tw = checkLotSizes(parseBhavcopyCsv(csvFor('2025-12-01', '75').replace(/2026-10-06/g, '2025-12-30')).filter((r) => r.instrumentType === 'IDX_OPT'));
    expect(tw[0].status).toBe('TRANSITION');
  });
  it('builds per-contract observations', () => {
    const obs = lotSizeObservations(parseBhavcopyCsv(csvFor('2026-10-05')));
    expect(obs.get('NIFTY|2026-10-06|2026-10-05')).toBe(65);
  });
});

describe('EOD historical provider is point-in-time safe', () => {
  it('serves the bhavcopy only after it is known, with null bid/ask', async () => {
    await fetchBhavcopy('2026-10-05', { env, fetchImpl: (async () => new Response(makeZip('x.csv', csvFor('2026-10-05')), { status: 200 })) as unknown as typeof fetch });
    const p = new BhavcopyHistoricalProvider(['2026-10-05'], env);
    const at1530 = new Date('2026-10-05T10:00:00Z'); // 15:30 IST — not yet published
    await expect(p.chainAt('NIFTY', '2026-10-06', at1530)).rejects.toThrow(/No bhavcopy known/);
    const evening = bhavcopyKnownAt('2026-10-05');
    const snap = await new PointInTimeGuard(p, () => evening).chainAt('NIFTY', '2026-10-06', evening);
    expect(snap.lotSize).toBe(65);
    expect(snap.quotes.every((q) => q.bid === null && q.ask === null)).toBe(true);
    // Guard still blocks future-stamped access.
    const g = new PointInTimeGuard(p, () => at1530);
    await expect(g.chainAt('NIFTY', '2026-10-06', evening)).rejects.toBeInstanceOf(LookAheadError);
  });
});

// ── Quote recorder ──────────────────────────────────────────────────────

class FakeChainProvider extends BaseProvider {
  readonly name = 'fake';
  asOf = '2026-10-05T05:30:00.000Z';
  quality: 'FULL' | 'DEGRADED' = 'FULL';
  async initialize() { this._ready = true; }
  async getOptionChain(symbol: string, expiry?: string): Promise<OptionChainData> {
    const exp = expiry ?? '2026-10-06';
    const strikes = Array.from({ length: 41 }, (_, i) => 24000 + i * 50);
    return {
      symbol, underlyingValue: 25010, expiryDate: exp, expiryDates: ['2026-10-06', '2026-10-13'], strikePrices: strikes,
      rows: strikes.map((k) => ({
        strikePrice: k, expiryDate: exp,
        CE: { strikePrice: k, expiryDate: exp, optionType: 'CE', lastPrice: 10, change: null, pChange: null, openInterest: 1, changeinOpenInterest: 0, totalTradedVolume: 1, impliedVolatility: 12, bidQty: 65, bidPrice: 9.9, askQty: 65, askPrice: 10.1, underlyingValue: 25010 },
        PE: { strikePrice: k, expiryDate: exp, optionType: 'PE', lastPrice: 10, change: null, pChange: null, openInterest: 1, changeinOpenInterest: 0, totalTradedVolume: 1, impliedVolatility: 12, bidQty: null, bidPrice: null, askQty: 65, askPrice: 10.2, underlyingValue: 25010 },
      })),
      timestamp: '05-Oct-2026 11:00:00',
      dataQuality: { status: this.quality, source: 'nse-primary', unavailableFields: [], reasons: [], asOf: this.asOf, fetchedAt: this.asOf },
      totalCEOpenInterest: 0, totalPEOpenInterest: 0, totalCEVolume: 0, totalPEVolume: 0,
    };
  }
  async getQuote(): Promise<never> { throw new Error('n/a'); }
  async getQuotes() { return new Map(); }
  async getExpiryDates() { return []; }
  async getSpotPrice() { return 0; }
  async getHistoricalData() { return []; }
  async getInstruments() { return []; }
  async getMarketStatus() { return { market: '', status: 'Open' as const, timestamp: '' }; }
}

describe('QuoteRecorder', () => {
  const setup = (marketOpen = true) => {
    const files: Record<string, QuoteSnapshotRow[]> = {};
    const prov = new FakeChainProvider();
    const rec = new QuoteRecorder({
      provider: prov, symbols: ['NIFTY'], strikesEachSide: 2, now: () => new Date('2026-10-05T05:31:00Z'),
      marketOpen: () => marketOpen, write: (f, rows) => { (files[f] ??= []).push(...rows); },
    });
    return { files, prov, rec };
  };
  it('records ATM±N for nearest and next expiry, keeping nulls as null', async () => {
    const { files, rec } = setup();
    const r = await rec.cycle();
    expect(r.written).toBe(2 * 5 * 2); // 2 expiries × 5 strikes × CE/PE
    const rows = files['2026-10-05_NIFTY.jsonl'];
    expect(new Set(rows.map((x) => x.strike))).toEqual(new Set([24900, 24950, 25000, 25050, 25100]));
    const pe = rows.find((x) => x.type === 'PE')!;
    expect(pe.bid).toBeNull();
    expect(pe.sourceAsOf).toBe('2026-10-05T05:30:00.000Z');
  });
  it('dedupes unchanged source timestamps and writes again when data updates', async () => {
    const { files, prov, rec } = setup();
    await rec.cycle();
    const second = await rec.cycle();
    expect(second.written).toBe(0);
    expect(second.skipped.some((s) => /unchanged/.test(s.reason))).toBe(true);
    prov.asOf = '2026-10-05T05:30:30.000Z';
    expect((await rec.cycle()).written).toBe(20);
    expect(files['2026-10-05_NIFTY.jsonl']).toHaveLength(40);
  });
  it('does nothing when the market is closed', async () => {
    const { files, rec } = setup(false);
    const r = await rec.cycle();
    expect(r.written).toBe(0);
    expect(Object.keys(files)).toHaveLength(0);
  });
  it('skips non-FULL data by default', async () => {
    const { rec, prov } = setup();
    prov.quality = 'DEGRADED';
    const r = await rec.cycle();
    expect(r.written).toBe(0);
    expect(r.skipped[0].reason).toMatch(/quality DEGRADED/);
  });
  it('writes JSONL files under the data directory by default', async () => {
    const rec = new QuoteRecorder({ provider: new FakeChainProvider(), symbols: ['NIFTY'], strikesEachSide: 1, includeNextExpiry: false,
      now: () => new Date('2026-10-05T05:31:00Z'), marketOpen: () => true, env });
    await rec.cycle();
    const dir = join(env.OPTIONS_HQ_DATA_DIR, 'quotes', 'nse-fo');
    expect(readdirSync(dir)).toEqual(['2026-10-05_NIFTY.jsonl']);
  });
  it('spreadStats summarises recorded spreads', () => {
    const rows = [{ bid: 9.9, ask: 10.1 }, { bid: 9.8, ask: 10.2 }, { bid: null, ask: 10 }] as QuoteSnapshotRow[];
    const s = spreadStats(rows);
    expect(s.n).toBe(2);
    expect(s.medianSpread).toBeCloseTo(0.4, 10);
  });
});
