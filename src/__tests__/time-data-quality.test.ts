/**
 * Time-zone independence, expiry rules, NSE mapping and data-quality gates.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeExpiry, expiryInstant, timeToExpiryYears, parseSourceTimestamp, istDate,
} from '../utils/time.js';
import { daysToExpiry } from '../utils/date.js';
import { getNextExpiry } from '../data/constants/expiry-calendar.js';
import { NSEProvider } from '../data/providers/nse.provider.js';
import { assessFreshness } from '../data/quality.js';
import { redact, redactObject } from '../utils/redact.js';

describe('time utilities', () => {
  it('expiry instant is 15:30 IST = 10:00 UTC regardless of host TZ', () => {
    expect(expiryInstant('2026-10-06').toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(expiryInstant('06-Oct-2026').toISOString()).toBe('2026-10-06T10:00:00.000Z');
  });
  it('time to expiry is exact and zero after expiry', () => {
    const now = new Date('2026-10-06T04:30:00Z'); // 10:00 IST on expiry day
    expect(timeToExpiryYears('2026-10-06', now) * 365 * 24).toBeCloseTo(5.5, 9);
    expect(timeToExpiryYears('2026-10-06', new Date('2026-10-06T10:00:01Z'))).toBe(0);
  });
  it('normalizeExpiry rejects impossible dates', () => {
    expect(normalizeExpiry('2026-02-30')).toBeNull();
    expect(normalizeExpiry('31-Sep-2026')).toBeNull();
    expect(normalizeExpiry('garbage')).toBeNull();
    expect(normalizeExpiry('6-Oct-2026')).toBe('2026-10-06');
  });
  it('parses NSE and Kite timestamps as IST and never substitutes now', () => {
    expect(parseSourceTimestamp('03-Oct-2026 15:30:00')!.toISOString()).toBe('2026-10-03T10:00:00.000Z');
    expect(parseSourceTimestamp('2026-10-03 15:29:59')!.toISOString()).toBe('2026-10-03T09:59:59.000Z');
    expect(parseSourceTimestamp(undefined)).toBeNull();
    expect(parseSourceTimestamp('nonsense')).toBeNull();
  });
  it('istDate rolls over at IST midnight', () => {
    expect(istDate(new Date('2026-10-03T18:29:00Z'))).toBe('2026-10-03');
    expect(istDate(new Date('2026-10-03T18:31:00Z'))).toBe('2026-10-04');
  });
  it('legacy daysToExpiry no longer depends on parse-time TZ shifts', () => {
    const d = daysToExpiry('2099-01-10');
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });
});

describe('computed expiry calendar (post-2025-09-01 rules)', () => {
  const from = new Date(Date.UTC(2026, 9, 3)); // Sat 3 Oct 2026
  it('NIFTY weekly expires Tuesday', () => {
    expect(getNextExpiry('NIFTY', true, from).toISOString().slice(0, 10)).toBe('2026-10-06');
  });
  it('NSE monthly = last Tuesday', () => {
    expect(getNextExpiry('BANKNIFTY', false, from).toISOString().slice(0, 10)).toBe('2026-10-27');
    expect(getNextExpiry('RELIANCE', false, from).toISOString().slice(0, 10)).toBe('2026-10-27');
  });
  it('BANKNIFTY has no weekly — falls back to monthly', () => {
    expect(getNextExpiry('BANKNIFTY', true, from).toISOString().slice(0, 10)).toBe('2026-10-27');
  });
  it('SENSEX weekly is Thursday', () => {
    expect(getNextExpiry('SENSEX', true, from).toISOString().slice(0, 10)).toBe('2026-10-08');
  });
});

// ── NSE mapping fixtures ────────────────────────────────────────────────

function primaryFixture() {
  const leg = (strike: number, exp: string, ltp: number, iv: number, bid: number, ask: number, oi: number, chg: number) =>
    ({ strikePrice: strike, expiryDate: exp, lastPrice: ltp, impliedVolatility: iv, bidprice: bid, askPrice: ask, openInterest: oi, changeinOpenInterest: chg, totalTradedVolume: 10 });
  return {
    records: {
      expiryDates: ['06-Oct-2026', '13-Oct-2026'],
      strikePrices: [24900, 25000, 25100],
      timestamp: '05-Oct-2026 11:00:00',
      underlyingValue: 25010,
      data: [
        { strikePrice: 25000, expiryDate: '06-Oct-2026', CE: leg(25000, '06-Oct-2026', 120, 12.5, 119, 121, 1000, 50), PE: leg(25000, '06-Oct-2026', 100, 13, 99, 101, 900, -20) },
        { strikePrice: 25100, expiryDate: '06-Oct-2026', CE: leg(25100, '06-Oct-2026', 0, 0, 0, 0, 0, 0) },
        { strikePrice: 25000, expiryDate: '13-Oct-2026', CE: leg(25000, '13-Oct-2026', 999, 15, 998, 1000, 77777, 0) },
      ],
    },
    filtered: { CE: { totOI: 123456789, totVol: 1 }, PE: { totOI: 1, totVol: 1 } },
  };
}

describe('NSE primary chain mapping', () => {
  const p = new NSEProvider() as unknown as { mapOptionChain: (s: string, raw: unknown, e?: string) => import('../data/providers/base.provider.js').OptionChainData };

  it('resolves exactly one expiry (regression: rows of all expiries were mixed)', () => {
    const c = p.mapOptionChain('NIFTY', primaryFixture());
    expect(c.expiryDate).toBe('2026-10-06');
    expect(c.rows.every((r) => r.expiryDate === '2026-10-06')).toBe(true);
    expect(c.rows.find((r) => r.strikePrice === 25000)!.CE!.lastPrice).toBe(120);
  });
  it('recomputes totals from rows (regression: used nearest-expiry filtered totals)', () => {
    const c = p.mapOptionChain('NIFTY', primaryFixture(), '2026-10-13');
    expect(c.totalCEOpenInterest).toBe(77777);
  });
  it('maps zero LTP/IV/bid/ask to null, keeps real zero OI', () => {
    const c = p.mapOptionChain('NIFTY', primaryFixture());
    const ce = c.rows.find((r) => r.strikePrice === 25100)!.CE!;
    expect(ce.lastPrice).toBeNull();
    expect(ce.impliedVolatility).toBeNull();
    expect(ce.bidPrice).toBeNull();
    expect(ce.askPrice).toBeNull();
    expect(ce.openInterest).toBe(0);
  });
  it('rejects an expiry that is not listed', () => {
    expect(() => p.mapOptionChain('NIFTY', primaryFixture(), '2026-10-20')).toThrow(/not listed/);
  });
  it('records source timestamp as asOf', () => {
    const c = p.mapOptionChain('NIFTY', primaryFixture());
    expect(c.dataQuality.asOf).toBe('2026-10-05T05:30:00.000Z');
    expect(c.dataQuality.status).toBe('FULL');
  });
});

describe('NSE fallback chain is DEGRADED with explicit unavailable fields', () => {
  it('never writes 0 for IV / bid / ask / change in OI', async () => {
    const prov = new NSEProvider() as unknown as {
      nseFetch: () => Promise<unknown>;
      getOptionChainFromDerivatives: (s: string, e?: string) => Promise<import('../data/providers/base.provider.js').OptionChainData>;
    };
    prov.nseFetch = async () => ({
      timestamp: '05-Oct-2026 11:00:00',
      data: [
        { underlying: 'NIFTY', instrumentType: 'OPTIDX', expiryDate: '06-Oct-2026', optionType: 'Call', strikePrice: 25000, lastPrice: 120, openInterest: 1000, volume: 5, underlyingValue: 25010 },
      ],
    });
    const c = await prov.getOptionChainFromDerivatives('NIFTY');
    const ce = c.rows[0].CE!;
    expect(ce.impliedVolatility).toBeNull();
    expect(ce.bidPrice).toBeNull();
    expect(ce.askPrice).toBeNull();
    expect(ce.changeinOpenInterest).toBeNull();
    expect(c.dataQuality.status).toBe('DEGRADED');
    expect(c.dataQuality.unavailableFields).toContain('impliedVolatility');
  });
});

describe('freshness gate', () => {
  const p = new NSEProvider() as unknown as { mapOptionChain: (s: string, raw: unknown) => import('../data/providers/base.provider.js').OptionChainData };
  const chain = p.mapOptionChain('NIFTY', primaryFixture());
  it('FULL when fresh during market hours', () => {
    const q = assessFreshness(chain, { now: new Date('2026-10-05T05:31:00Z'), marketOpen: true });
    expect(q.status).toBe('FULL');
    expect(q.ageSeconds).toBe(60);
  });
  it('STALE when older than the limit', () => {
    expect(assessFreshness(chain, { now: new Date('2026-10-05T05:40:00Z'), marketOpen: true }).status).toBe('STALE');
  });
  it('STALE when market is closed', () => {
    expect(assessFreshness(chain, { now: new Date('2026-10-05T05:31:00Z'), marketOpen: false }).status).toBe('STALE');
  });
  it('UNAVAILABLE when there are no rows', () => {
    expect(assessFreshness({ ...chain, rows: [] }, { now: new Date('2026-10-05T05:31:00Z'), marketOpen: true }).status).toBe('UNAVAILABLE');
  });
});

describe('redaction', () => {
  it('removes credential material from text and objects', () => {
    expect(redact('Authorization: token abcdefgh12:zyxwvuts98')).not.toMatch(/abcdefgh12|zyxwvuts98/);
    expect(redact('{"access_token":"s3cr3tvalue123"}')).not.toContain('s3cr3tvalue123');
    expect(redact('Cookie: nsit=abc; nseappid=def')).not.toContain('nsit=abc');
    const o = redactObject({ apiKey: 'k', nested: { access_token: 't', ok: 1 } });
    expect(o).toEqual({ apiKey: '[REDACTED]', nested: { access_token: '[REDACTED]', ok: 1 } });
  });
});
