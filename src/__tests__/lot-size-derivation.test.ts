import { describe, it, expect } from 'vitest';
import { deriveLotHistory, renderLotHistoryModule } from '../history/lot-size-derivation.js';

const o = (tradeDate: string, symbol: string, lotSize: number) => ({ tradeDate, symbol, lotSize });

describe('lot-size history derivation', () => {
  const rows = [
    // NIFTY: 75 uniform, then a transition day (75 and 65 contracts), then 65 uniform.
    o('2025-11-28', 'NIFTY', 75), o('2025-11-28', 'NIFTY', 75),
    o('2025-12-01', 'NIFTY', 75), o('2025-12-01', 'NIFTY', 65),
    o('2026-01-01', 'NIFTY', 65), o('2026-01-02', 'NIFTY', 65),
    // ABC: dropped out of F&O before the end of the data.
    o('2025-11-28', 'ABC', 500), o('2025-12-01', 'ABC', 500),
    // XYZ: present on the last date.
    o('2025-12-01', 'XYZ', 1000), o('2026-01-02', 'XYZ', 1000),
  ];
  const h = deriveLotHistory(rows);

  it('splits uniform periods around transition days and marks the current period open-ended', () => {
    expect(h.periods.NIFTY).toEqual([['2025-11-28', '2025-11-28', 75], ['2026-01-01', null, 65]]);
    expect(h.transitions.NIFTY).toEqual(['2025-12-01']);
  });
  it('keeps a closed period for symbols that left F&O', () => {
    expect(h.periods.ABC).toEqual([['2025-11-28', '2025-12-01', 500]]);
    expect(h.periods.XYZ).toEqual([['2025-12-01', null, 1000]]);
  });
  it('reports the data range', () => {
    expect(h).toMatchObject({ dataFrom: '2025-11-28', dataTo: '2026-01-02', tradeDates: 4 });
  });
  it('renders a deterministic module', () => {
    const a = renderLotHistoryModule(h, 'test');
    expect(a).toBe(renderLotHistoryModule(deriveLotHistory([...rows].reverse()), 'test'));
    expect(a).toContain('"NIFTY": [["2025-11-28","2025-11-28",75],["2026-01-01",null,65]]');
  });
  it('rejects empty input', () => {
    expect(() => deriveLotHistory([])).toThrow();
  });
});
