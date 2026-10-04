/**
 * EOD backtest engine tests on hand-computed synthetic bhavcopy data.
 */
import { describe, it, expect } from 'vitest';
import type { BhavRecord } from '../history/bhavcopy.js';
import { finalSettlementPrice } from '../history/bhavcopy.js';
import { runEodBacktest, EOD_PESSIMISTIC_V1, type EodStrategy, type EveningContext } from '../backtest/eod-engine.js';
import { buildReport, renderMarkdown, midpoint } from '../backtest/report.js';
import { createRefIronCondor, REF_IRON_CONDOR_SPEC } from '../strategy/reference/nifty-weekly-iron-condor.js';

const D1 = '2026-09-22'; // expiry day of the previous weekly contract (signal evening)
const D2 = '2026-09-23'; // fill day
const D3 = '2026-09-24';
const E = '2026-09-29';  // expiry of the traded contract

function opt(tradeDate: string, expiry: string, strike: number, type: 'CE' | 'PE', close: number, vol = 1000, settle: number | null = close, und = 25000): BhavRecord {
  return {
    tradeDate, symbol: 'NIFTY', instrumentType: 'IDX_OPT', expiry, strike, optionType: type,
    open: close, high: close, low: close, close, lastPrice: close, previousClose: close, settlementPrice: settle,
    underlyingPrice: und, openInterest: 1000, changeInOpenInterest: 0, volumeContracts: vol, notionalTurnover: 0, trades: 1, lotSize: 65,
  };
}

const STRIKES = [24000, 24250, 24500, 24750, 25000, 25250, 25500, 25750, 26000];
function chainFor(date: string, expiry: string, priceOf: (k: number, t: 'CE' | 'PE') => number, und = 25000, settleExpiry?: number): BhavRecord[] {
  const out: BhavRecord[] = [];
  for (const k of STRIKES) for (const t of ['CE', 'PE'] as const) {
    out.push(opt(date, expiry, k, t, priceOf(k, t), 1000, date === expiry ? (settleExpiry ?? und) : priceOf(k, t), und));
  }
  return out;
}

// D1: expiring contract (D1) + next contract (E). D2/D3: E chain. E: expiry day, settlement 25600.
const prices: Record<string, number> = { '24250PE': 5, '24500PE': 12, '25500CE': 10, '25750CE': 4 };
const p = (k: number, t: 'CE' | 'PE') => prices[`${k}${t}`] ?? 20;
const DATA: Record<string, BhavRecord[]> = {
  [D1]: [...chainFor(D1, D1, () => 1, 25000), ...chainFor(D1, E, p)],
  [D2]: chainFor(D2, E, p),
  [D3]: chainFor(D3, E, p),
  [E]: chainFor(E, E, (k, t) => (t === 'CE' ? Math.max(25600 - k, 0.05) : Math.max(k - 25600, 0.05)), 25600, 25600),
};
const DATES = Object.keys(DATA).sort();
const load = (d: string) => DATA[d] ?? [];

describe('final settlement price', () => {
  it('reads the expiry-day settlement from option rows and refuses disagreement', () => {
    expect(finalSettlementPrice(DATA[E], 'NIFTY', E)).toBe(25600);
    const bad = [...DATA[E]];
    bad[0] = { ...bad[0], settlementPrice: 1 };
    expect(() => finalSettlementPrice(bad, 'NIFTY', E)).toThrow(/disagree/);
    expect(() => finalSettlementPrice(DATA[D2], 'NIFTY', E)).toThrow(/No NIFTY options expiring/);
  });
});

describe('reference iron condor on synthetic data (hand-computed)', () => {
  const run = () => runEodBacktest({ strategy: createRefIronCondor(), tradeDates: DATES, load, from: DATES[0], to: DATES[DATES.length - 1] });
  const res = run();

  it('signals on the expiry-day evening and fills at the NEXT day close with the spread against it', () => {
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.signalDate).toBe(D1);
    expect(t.entryDate).toBe(D2);
    const legs = Object.fromEntries(t.legs.map((l) => [`${l.strike}${l.type}`, l]));
    expect(legs['24250PE']).toMatchObject({ side: 'BUY', close: 5, fillPrice: 5.1, lotSize: 65 });
    expect(legs['24500PE']).toMatchObject({ side: 'SELL', close: 12, fillPrice: 11.75 });
    expect(legs['25500CE']).toMatchObject({ side: 'SELL', close: 10, fillPrice: 9.8 });
    expect(legs['25750CE']).toMatchObject({ side: 'BUY', close: 4, fillPrice: 4.1 });
  });

  it('settles at the exchange price: gross, slippage and net by hand', () => {
    const t = res.trades[0];
    expect(t.settlementPrice).toBe(25600);
    // Gross at reference closes: credit (12 + 10 − 5 − 4) × 65 = 845; short 25500 CE pays 100 × 65 = 6,500.
    expect(t.pnl.grossPnL).toBe(845 - 6500);
    // Spread paid: (0.10 + 0.25 + 0.20 + 0.10) × 65 = 42.25
    expect(t.pnl.slippage).toBe(42.25);
    expect(t.pnl.netPnL).toBeLessThan(t.pnl.grossPnL - t.pnl.slippage); // charges are positive
    expect(t.pnl.brokerage).toBe(4 * 20 + 4 * 20); // 4 entry orders + settlement brokerage on 4 legs
    expect(t.pnl.classification).toBe('NET_LOSS');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(res));
  });

  it('builds a report whose verdict uses net results', () => {
    const rep = buildReport(res);
    expect(rep.all.trades).toBe(1);
    expect(rep.all.verdict).toBe('UNKNOWN'); // far below the minimum sample
    const md = renderMarkdown(rep);
    expect(md).toContain('**NET P&L**');
    expect(md).toContain('ref_nifty_weekly_iron_condor');
  });
});

describe('no look-ahead and skip handling', () => {
  it('the strategy only ever sees rows dated that evening', () => {
    const seen: Array<{ date: string; rowDates: string[] }> = [];
    const spy: EodStrategy = {
      id: 'spy', version: '0.0.1', fingerprint: 'x', symbols: ['NIFTY'],
      onEvening: (ctx: EveningContext) => { seen.push({ date: ctx.date, rowDates: [...new Set(ctx.rows.map((r) => r.tradeDate))] }); return null; },
    };
    runEodBacktest({ strategy: spy, tradeDates: DATES, load, from: DATES[0], to: DATES[DATES.length - 1] });
    expect(seen.map((s) => s.date)).toEqual(DATES);
    for (const s of seen) expect(s.rowDates).toEqual([s.date]);
  });

  it('skips (and records) a trade whose leg did not trade on the fill day', () => {
    const data = { ...DATA, [D2]: DATA[D2].map((r) => (r.strike === 25750 && r.optionType === 'CE' ? { ...r, volumeContracts: 0 } : r)) };
    const res = runEodBacktest({ strategy: createRefIronCondor(), tradeDates: DATES, load: (d) => data[d] ?? [], from: DATES[0], to: DATES[DATES.length - 1] });
    expect(res.trades).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/25750 untraded/);
  });

  it('skips when the next trading day is the expiry', () => {
    const dates = [D1, E];
    const res = runEodBacktest({ strategy: createRefIronCondor(), tradeDates: dates, load, from: D1, to: E });
    expect(res.trades).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/on\/after expiry/);
  });

  it('fails closed outside the charge schedules', () => {
    const shift = (r: BhavRecord, date: string, exp: string): BhavRecord => ({ ...r, tradeDate: date, expiry: r.expiry === D1 ? '2024-07-11' : exp });
    const old: Record<string, BhavRecord[]> = {
      '2024-07-11': DATA[D1].map((r) => shift(r, '2024-07-11', '2024-07-18')),
      '2024-07-12': DATA[D2].map((r) => shift(r, '2024-07-12', '2024-07-18')),
      '2024-07-18': DATA[E].map((r) => ({ ...r, tradeDate: '2024-07-18', expiry: '2024-07-18' })),
    };
    expect(() => runEodBacktest({ strategy: createRefIronCondor(), tradeDates: Object.keys(old), load: (d) => old[d], from: '2024-07-11', to: '2024-07-18' }))
      .toThrow(/No charge schedule|lot-size|Refusing/);
  });
});

describe('reference spec', () => {
  it('is a validated, versioned BACKTEST-status spec with a defined-risk structure', () => {
    expect(REF_IRON_CONDOR_SPEC.status).toBe('BACKTEST');
    expect(REF_IRON_CONDOR_SPEC.structure.definedRiskOnly).toBe(true);
    expect(EOD_PESSIMISTIC_V1.halfSpread(3)).toBe(0.1);
    expect(EOD_PESSIMISTIC_V1.halfSpread(50)).toBe(1);
  });
  it('midpoint split is fixed by the date range', () => {
    expect(midpoint('2024-10-01', '2026-10-01')).toBe('2025-10-01');
  });
});
