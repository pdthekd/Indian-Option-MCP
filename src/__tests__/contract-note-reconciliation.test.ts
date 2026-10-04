/**
 * Contract-note reconciliation on a synthetic, hand-computed note (no personal data).
 */
import { describe, it, expect } from 'vitest';
import { reconcileNote, summarize } from '../costs/contract-note-reconciliation.js';

// One option round trip on 2025-06-02: BUY 75 @ 100 (order a), SELL 75 @ 110 in two fills of one order (b).
// Turnover 7,500 + 8,250 = 15,750. Brokerage 2 orders × ₹20 = 40. Exchange 0.03553 % = 5.595975 → 5.60.
// STT 0.1 % × 8,250 = 8.25 → ₹8. Stamp 0.003 % × 7,500 = 0.225 → ₹0. SEBI ₹10/crore → 0.01575 → 0.02.
// GST 18 % on (40 + 5.60 + 0.02) = 45.62 → CGST 4.1058 → 4.11 ×2 = 8.22.
const note = {
  schema: 'contract-note/v1', tradeDate: '2025-06-02', segment: 'NSE-FO',
  fills: [
    { orderId: 'a', instrument: 'OPTION', side: 'BUY', quantity: 75, price: 100 },
    { orderId: 'b', instrument: 'OPTION', side: 'SELL', quantity: 25, price: 110 },
    { orderId: 'b', instrument: 'OPTION', side: 'SELL', quantity: 50, price: 110 },
  ],
  reported: { brokerage: 40, exchangeTxn: 5.6, clearing: 0, stt: 8, sebiFee: 0.02, stampDuty: 0, gst: 8.22 },
};

describe('contract-note reconciliation', () => {
  it('reproduces a hand-computed note exactly', () => {
    const r = reconcileNote(note);
    expect(r.orders).toBe(2);
    expect(r.model).toMatchObject({ brokerage: 40, exchangeTxn: 5.6, stt: 8, sebiFee: 0.02, stampDuty: 0, gst: 8.22 });
    expect(r.exact).toBe(true);
    expect(summarize([r]).verdict).toBe('PASS');
  });
  it('flags a component mismatch and fails the verdict beyond tolerance', () => {
    const r = reconcileNote({ ...note, reported: { ...note.reported, brokerage: 60 } });
    expect(r.exact).toBe(false);
    expect(r.diff.brokerage).toBe(-20);
    expect(summarize([r]).verdict).toBe('FAIL');
  });
  it('rejects malformed notes instead of guessing', () => {
    expect(() => reconcileNote({ ...note, schema: 'x' })).toThrow();
    expect(() => reconcileNote({ ...note, fills: [] })).toThrow();
    expect(() => reconcileNote({ ...note, tradeDate: '02-06-2025' })).toThrow();
  });
});
