import { describe, it, expect } from 'vitest';
import { lotSizeFor, observationKey, getLotSize, isFnOSymbol } from '../data/constants/lot-sizes.js';
import { LOT_HISTORY_META } from '../data/constants/lot-history.generated.js';

// Expected values are NSE bhavcopy facts (NewBrdLotQty); the generated history covers
// LOT_HISTORY_META.dataFrom → dataTo.
describe('lot sizes from NSE bhavcopy history', () => {
  it('covers the expected data range', () => {
    expect(LOT_HISTORY_META.dataFrom).toBe('2024-07-08');
    expect(LOT_HISTORY_META.dataTo >= '2026-10-01').toBe(true);
  });
  it('NIFTY: 25 → 75 → 65 by trade date', () => {
    expect(lotSizeFor('NIFTY', '2024-10-31', '2024-10-01').lotSize).toBe(25);
    expect(lotSizeFor('NIFTY', '2025-05-15', '2025-05-09')).toMatchObject({ lotSize: 75, verification: 'BHAVCOPY_DAILY' });
    // A long-dated contract traded in May 2025 was 75, not 65.
    expect(lotSizeFor('NIFTY', '2026-12-31', '2025-05-09').lotSize).toBe(75);
    expect(lotSizeFor('NIFTY', '2026-09-29', '2026-09-28').lotSize).toBe(65);
  });
  it('after the last downloaded day the current size is used and flagged', () => {
    const r = lotSizeFor('NIFTY', '2026-12-29', '2026-12-15');
    expect(r).toMatchObject({ lotSize: 65, verification: 'BHAVCOPY_LATEST' });
    expect(r.source).toMatch(/assumed unchanged/);
  });
  it('other indices', () => {
    expect(lotSizeFor('BANKNIFTY', '2025-03-27', '2025-03-03').lotSize).toBe(30);
    expect(lotSizeFor('BANKNIFTY', '2025-08-28', '2025-08-01').lotSize).toBe(35);
    expect(lotSizeFor('FINNIFTY', '2025-06-26', '2025-06-02').lotSize).toBe(65);
    expect(lotSizeFor('MIDCPNIFTY', '2025-09-30', '2025-09-01').lotSize).toBe(140);
    expect(lotSizeFor('NIFTYNXT50', '2026-10-27', '2026-10-01').lotSize).toBe(25);
  });
  it('stocks, including corporate-action changes', () => {
    expect(lotSizeFor('RELIANCE', '2024-10-31', '2024-10-01').lotSize).toBe(250);
    expect(lotSizeFor('RELIANCE', '2026-10-27', '2026-10-01').lotSize).toBe(500); // after the 1:1 bonus
    expect(lotSizeFor('TCS', '2026-10-27', '2026-10-01').lotSize).toBe(225);
    expect(getLotSize('IDEA')).toBe(71475);
  });
  it('symbols that left F&O, never listed, or renamed', () => {
    expect(() => lotSizeFor('ZOMATO', '2026-10-27', '2026-10-01')).toThrow(/no F&O contracts after 2025-04-08/);
    expect(lotSizeFor('ETERNAL', '2026-10-27', '2026-10-01').lotSize).toBe(2425);
    expect(() => lotSizeFor('HDFC', '2026-10-27', '2026-10-01')).toThrow(/not an NSE F&O symbol/);
    expect(isFnOSymbol('ZOMATO')).toBe(false);
    expect(isFnOSymbol('ETERNAL')).toBe(true);
  });
  it('transition windows fail closed unless the day\'s bhavcopy observation is supplied', () => {
    expect(() => lotSizeFor('BANKNIFTY', '2025-05-29', '2025-05-09')).toThrow(/transition window/);
    const obs = new Map([[observationKey('BANKNIFTY', '2025-05-29', '2025-05-09'), 30]]);
    expect(lotSizeFor('BANKNIFTY', '2025-05-29', '2025-05-09', obs)).toMatchObject({ lotSize: 30, verification: 'EXCHANGE_BHAVCOPY' });
  });
  it('fails closed before the history and for impossible dates', () => {
    expect(() => lotSizeFor('NIFTY', '2024-06-27', '2024-06-20')).toThrow(/Refusing to guess/);
    expect(() => lotSizeFor('NIFTY', '2026-10-06', '2026-10-07')).toThrow(/does not trade/);
    expect(() => lotSizeFor('NIFTY', '06-Oct-2026', '2026-10-01')).toThrow();
  });
});
