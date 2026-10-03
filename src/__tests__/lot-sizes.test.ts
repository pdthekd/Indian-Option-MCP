import { describe, it, expect } from 'vitest';
import { lotSizeFor } from '../data/constants/lot-sizes.js';

describe('versioned lot sizes (by contract expiry)', () => {
  it('NIFTY is 75 for 2025 expiries (seen on contract notes) and 65 from January 2026', () => {
    expect(lotSizeFor('NIFTY', '2025-05-15')).toMatchObject({ lotSize: 75, verification: 'CONTRACT_NOTE_OBSERVED' });
    expect(lotSizeFor('NIFTY', '2025-12-30').lotSize).toBe(75);
    expect(lotSizeFor('NIFTY', '2026-01-06')).toMatchObject({ lotSize: 65, verification: 'USER_PROVIDED' });
    expect(lotSizeFor('nifty', '2026-10-06').lotSize).toBe(65);
  });
  it('other index revisions are applied but flagged UNVERIFIED', () => {
    expect(lotSizeFor('BANKNIFTY', '2026-10-27')).toMatchObject({ lotSize: 30, verification: 'UNVERIFIED' });
    expect(lotSizeFor('FINNIFTY', '2026-10-27').lotSize).toBe(60);
    expect(lotSizeFor('MIDCPNIFTY', '2025-06-24').lotSize).toBe(140);
  });
  it('fails closed for expiries before the recorded history', () => {
    expect(() => lotSizeFor('NIFTY', '2024-06-27')).toThrow(/Refusing to guess/);
  });
  it('stocks fall back to the static table and are UNVERIFIED', () => {
    expect(lotSizeFor('RELIANCE', '2026-10-27').verification).toBe('UNVERIFIED');
    expect(() => lotSizeFor('NOTASYMBOL', '2026-10-27')).toThrow();
  });
  it('rejects malformed expiry', () => {
    expect(() => lotSizeFor('NIFTY', '06-Oct-2026')).toThrow();
  });
});
