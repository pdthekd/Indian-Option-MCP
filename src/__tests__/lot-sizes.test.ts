import { describe, it, expect } from 'vitest';
import { lotSizeFor, observationKey } from '../data/constants/lot-sizes.js';

// Expected values below were read from NSE F&O bhavcopy files (NewBrdLotQty).
describe('index lot sizes by trade date', () => {
  it('NIFTY: 25 → 75 → 65 across uniform periods', () => {
    expect(lotSizeFor('NIFTY', '2024-10-31', '2024-10-01').lotSize).toBe(25);
    expect(lotSizeFor('NIFTY', '2025-05-15', '2025-05-09')).toMatchObject({ lotSize: 75, verification: 'BHAVCOPY_SAMPLED' });
    // Long-dated contract traded in May 2025 was 75 (not 65) — the old expiry-keyed rule got this wrong.
    expect(lotSizeFor('NIFTY', '2026-12-31', '2025-05-09').lotSize).toBe(75);
    expect(lotSizeFor('NIFTY', '2026-10-06', '2026-10-05').lotSize).toBe(65);
  });
  it('BANKNIFTY / FINNIFTY / MIDCPNIFTY / NIFTYNXT50 match bhavcopy history', () => {
    expect(lotSizeFor('BANKNIFTY', '2025-03-27', '2025-03-03').lotSize).toBe(30);
    expect(lotSizeFor('BANKNIFTY', '2025-08-28', '2025-08-01').lotSize).toBe(35);
    expect(lotSizeFor('BANKNIFTY', '2026-10-27', '2026-10-01').lotSize).toBe(30);
    expect(lotSizeFor('FINNIFTY', '2025-06-26', '2025-06-02').lotSize).toBe(65);
    expect(lotSizeFor('MIDCPNIFTY', '2025-09-30', '2025-09-01').lotSize).toBe(140);
    expect(lotSizeFor('NIFTYNXT50', '2026-10-27', '2026-10-01').lotSize).toBe(25);
  });
  it('transition windows fail closed unless the day\'s bhavcopy observation is supplied', () => {
    // 2025-05-09: BANKNIFTY near contracts 30, later contracts 35.
    expect(() => lotSizeFor('BANKNIFTY', '2025-05-29', '2025-05-09')).toThrow(/transition window/);
    const obs = new Map([
      [observationKey('BANKNIFTY', '2025-05-29', '2025-05-09'), 30],
      [observationKey('BANKNIFTY', '2025-07-31', '2025-05-09'), 35],
    ]);
    expect(lotSizeFor('BANKNIFTY', '2025-05-29', '2025-05-09', obs)).toMatchObject({ lotSize: 30, verification: 'EXCHANGE_BHAVCOPY' });
    expect(lotSizeFor('BANKNIFTY', '2025-07-31', '2025-05-09', obs).lotSize).toBe(35);
  });
  it('observations take precedence over periods', () => {
    const obs = new Map([[observationKey('NIFTY', '2026-10-06', '2026-10-05'), 65]]);
    expect(lotSizeFor('NIFTY', '2026-10-06', '2026-10-05', obs).verification).toBe('EXCHANGE_BHAVCOPY');
  });
  it('fails closed before recorded history and for impossible dates', () => {
    expect(() => lotSizeFor('NIFTY', '2024-06-27', '2024-06-20')).toThrow(/Refusing to guess/);
    expect(() => lotSizeFor('NIFTY', '2026-10-06', '2026-10-07')).toThrow(/does not trade/);
    expect(() => lotSizeFor('NIFTY', '06-Oct-2026', '2026-10-01')).toThrow();
  });
  it('stocks fall back to the static table and are UNVERIFIED', () => {
    expect(lotSizeFor('RELIANCE', '2026-10-27', '2026-10-01').verification).toBe('UNVERIFIED');
    expect(() => lotSizeFor('NOTASYMBOL', '2026-10-27', '2026-10-01')).toThrow();
  });
});
