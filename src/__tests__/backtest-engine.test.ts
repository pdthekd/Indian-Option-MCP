/**
 * EOD backtest engine tests on hand-computed synthetic bhavcopy data.
 */
import { describe, it, expect } from 'vitest';
import type { BhavRecord } from '../history/bhavcopy.js';
import { finalSettlementPrice } from '../history/bhavcopy.js';
import { runEodBacktest, missingTradingDays, EOD_PESSIMISTIC_V1, type EodStrategy, type EveningContext } from '../backtest/eod-engine.js';
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
  const run = () => runEodBacktest({ strategy: createRefIronCondor(), tradeDates: DATES, load, from: DATES[0], to: DATES[DATES.length - 1], requireContinuousData: false });
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
    // 4 entry orders + settlement brokerage only on the ITM leg (short 25500 CE assigned). Changed from 4×20 + 4×20
    // when brokerage plan r3 corrected OTM-expiry brokerage to ₹0 (Zerodha support article, 2026-10-04).
    expect(t.pnl.brokerage).toBe(4 * 20 + 20);
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
    runEodBacktest({ strategy: spy, tradeDates: DATES, load, from: DATES[0], to: DATES[DATES.length - 1], requireContinuousData: false });
    expect(seen.map((s) => s.date)).toEqual(DATES);
    for (const s of seen) expect(s.rowDates).toEqual([s.date]);
  });

  it('skips (and records) a trade whose leg did not trade on the fill day', () => {
    const data = { ...DATA, [D2]: DATA[D2].map((r) => (r.strike === 25750 && r.optionType === 'CE' ? { ...r, volumeContracts: 0 } : r)) };
    const res = runEodBacktest({ strategy: createRefIronCondor(), tradeDates: DATES, load: (d) => data[d] ?? [], from: DATES[0], to: DATES[DATES.length - 1], requireContinuousData: false });
    expect(res.trades).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/25750 untraded/);
  });

  it('skips when the next trading day is the expiry', () => {
    const dates = [D1, E];
    const res = runEodBacktest({ strategy: createRefIronCondor(), tradeDates: dates, load, from: D1, to: E, requireContinuousData: false });
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
    expect(() => runEodBacktest({ strategy: createRefIronCondor(), tradeDates: Object.keys(old), load: (d) => old[d], from: '2024-07-11', to: '2024-07-18', requireContinuousData: false }))
      .toThrow(/No charge schedule|lot-size|Refusing/);
  });
});

describe('fail-closed data checks', () => {
  it('refuses to run over a gap in the data (expected trading day missing)', () => {
    expect(() => runEodBacktest({ strategy: createRefIronCondor(), tradeDates: DATES, load, from: DATES[0], to: DATES[DATES.length - 1] }))
      .toThrow(/Data gap: no bhavcopy for expected trading day\(s\) 2026-09-25/);
  });
  it('refuses to leave a position unsettled when its expiry-day data is missing', () => {
    const dates = [D1, D2, D3, '2026-09-30'];
    const data: Record<string, BhavRecord[]> = { ...DATA, '2026-09-30': chainFor('2026-09-30', '2026-10-06', p) };
    expect(() => runEodBacktest({ strategy: createRefIronCondor(), tradeDates: dates, load: (d) => data[d] ?? [], from: D1, to: '2026-09-30', requireContinuousData: false }))
      .toThrow(/was not settled/);
  });
  it('missingTradingDays respects official holidays and weekends', () => {
    const r = missingTradingDays(['2026-10-01', '2026-10-05'], '2026-10-01', '2026-10-05'); // 2 Oct holiday, 3-4 weekend
    expect(r.missing).toEqual([]);
    expect(missingTradingDays(['2026-10-01'], '2026-10-01', '2026-10-05').missing).toEqual(['2026-10-05']);
  });
});

describe('contract identity by instrument id (NSE expiry relabelling)', () => {
  // The traded contracts (labelled E on D1/D2) are relabelled by NSE to E2 from D3 on, as NSE did on 2025-08-01.
  const E2 = '2026-09-30';
  const ids = (rows: BhavRecord[], label?: string) =>
    rows.map((r) => (r.expiry === E || r.expiry === E2 ? { ...r, instrumentId: `${r.strike}${r.optionType}`, expiry: label ?? r.expiry } : r));
  const settleDay = chainFor(E2, E2, (k, t) => (t === 'CE' ? Math.max(25600 - k, 0.05) : Math.max(k - 25600, 0.05)), 25600, 25600);
  const data: Record<string, BhavRecord[]> = {
    [D1]: ids(DATA[D1]), [D2]: ids(DATA[D2]), [D3]: ids(DATA[D3], E2), [E2]: ids(settleDay),
  };
  const dates = [D1, D2, D3, E2];
  const run = (d: Record<string, BhavRecord[]>) =>
    runEodBacktest({ strategy: createRefIronCondor(), tradeDates: dates, load: (x) => d[x] ?? [], from: D1, to: E2, requireContinuousData: false });

  it('follows a relabelled expiry and settles on the new date instead of failing or mis-settling', () => {
    const res = run(data);
    expect(res.expiryRelabels).toEqual([{ date: D3, from: E, to: E2 }]);
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]).toMatchObject({ expiry: E2, settlementPrice: 25600 });
    expect(res.trades[0].legs.every((l) => l.instrumentId)).toBe(true);
    expect(res.trades[0].pnl.grossPnL).toBe(845 - 6500); // same economics as the un-relabelled case
  });

  it('fails closed when a held contract disappears before its expiry', () => {
    const gone = { ...data, [D3]: data[D3].filter((r) => !(r.strike === 25500 && r.optionType === 'CE')) };
    expect(() => run(gone)).toThrow(/CE 25500 \(id 25500CE\) missing from 2026-09-24/);
  });

  it('records why an expiry evening produced no trade', () => {
    // On E2 evening the expiring contracts are the only ones listed: no later expiry.
    expect(run(data).noTrade).toEqual([{ date: E2, reason: 'No later NIFTY expiry listed' }]);
    const untraded = { ...data, [D1]: data[D1].map((r) => (r.expiry === E && r.strike === 25750 && r.optionType === 'CE' ? { ...r, volumeContracts: 0 } : r)) };
    const res = run(untraded);
    expect(res.trades).toHaveLength(0);
    expect(res.noTrade[0]).toEqual({ date: D1, reason: `Leg(s) not listed or untraded on ${D1} for ${E}: long call 25750` });
  });

  it('the parser keeps NSE FinInstrmId', async () => {
    const { parseBhavcopyCsv } = await import('../history/bhavcopy.js');
    const csv = 'TradDt,FinInstrmTp,FinInstrmId,TckrSymb,XpryDt,StrkPric,OptnTp,OpnPric,HghPric,LwPric,ClsPric,SttlmPric,OpnIntrst,TtlTradgVol,NewBrdLotQty,UndrlygPric\n'
      + '2025-08-01,IDO,64694,NIFTY,2025-09-30,25000.00,CE,1,1,1,1,1,1,1,75,24500\n';
    expect(parseBhavcopyCsv(csv)[0]).toMatchObject({ instrumentId: '64694', expiry: '2025-09-30' });
  });
});

describe('special (Muhurat) sessions', () => {
  // Signal on Monday expiry 2025-10-20; 2025-10-21 is a Muhurat session; 2025-10-22 a holiday; next regular session 2025-10-23.
  const S1 = '2025-10-20', MU = '2025-10-21', R = '2025-10-23', EX = '2025-10-28';
  const at = (rows: BhavRecord[], date: string, map: Record<string, string>) =>
    rows.map((r) => ({ ...r, tradeDate: date, expiry: map[r.expiry] ?? r.expiry, lotSize: 75 }));
  const data: Record<string, BhavRecord[]> = {
    [S1]: at(DATA[D1], S1, { [D1]: S1, [E]: EX }),
    [MU]: at(DATA[D2], MU, { [E]: EX }).map((r) => ({ ...r, close: (r.close as number) * 2 })), // Muhurat closes differ
    [R]: at(DATA[D2], R, { [E]: EX }),
    [EX]: at(DATA[E], EX, { [E]: EX }),
  };
  const run = (specialSessions?: 'NO_FILLS' | 'ALLOW_FILLS') => runEodBacktest({
    strategy: createRefIronCondor(), tradeDates: Object.keys(data), load: (d) => data[d], from: S1, to: EX,
    requireContinuousData: false, specialSessions,
  });

  it('by default does not fill in a special session: the order waits for the next regular close', () => {
    const res = run();
    expect(res.specialSessionPolicy).toBe('NO_FILLS');
    expect(res.deferredFills).toEqual([{ signalDate: S1, specialSession: MU }]);
    expect(res.trades[0].entryDate).toBe(R);
    expect(res.trades[0].legs.find((l) => l.strike === 24500)?.close).toBe(12); // regular-session close, not the doubled Muhurat close
  });
  it('ALLOW_FILLS reproduces the behaviour of results frozen before 2026-10-04', () => {
    const res = run('ALLOW_FILLS');
    expect(res.deferredFills).toEqual([]);
    expect(res.trades[0].entryDate).toBe(MU);
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
