/**
 * Golden-result comparison and data-version hashing.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDataVersion } from '../backtest/data-version.js';
import { compareGolden, type GoldenResult } from '../backtest/golden.js';
import { readFileSync } from 'node:fs';
import { fingerprint } from '../strategy/strategy-spec.js';
import { REF_IRON_CONDOR_SPEC } from '../strategy/reference/nifty-weekly-iron-condor.js';

const golden = (n: string) => JSON.parse(readFileSync(new URL(`../strategy/reference/golden/${n}`, import.meta.url), 'utf8')) as GoldenResult;
const original = golden('ref_iron_condor_v1.0.0_original_r2_v1.json');
const audited = golden('ref_iron_condor_v1.0.0_audited_r3_v1.json');

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dv-'));
  mkdirSync(join(root, 'raw'));
  mkdirSync(join(root, 'normalized'));
  for (const [d, body] of Object.entries(files)) {
    writeFileSync(join(root, 'raw', `${d}.csv.zip`), `raw-${body}`);
    writeFileSync(join(root, 'normalized', `${d}.jsonl`), body);
  }
  return root;
}

describe('data version', () => {
  it('changes when any day is altered, missing or added', () => {
    const a = computeDataVersion(makeRoot({ '2026-01-01': 'x', '2026-01-02': 'y' }), ['2026-01-01', '2026-01-02']);
    const same = computeDataVersion(makeRoot({ '2026-01-01': 'x', '2026-01-02': 'y' }), ['2026-01-02', '2026-01-01']);
    const altered = computeDataVersion(makeRoot({ '2026-01-01': 'x', '2026-01-02': 'z' }), ['2026-01-01', '2026-01-02']);
    expect(same.rawSha256).toBe(a.rawSha256);
    expect(same.normalizedSha256).toBe(a.normalizedSha256);
    expect(altered.rawSha256).not.toBe(a.rawSha256);
    expect(computeDataVersion(makeRoot({ '2026-01-01': 'x' }), ['2026-01-01']).rawSha256).not.toBe(a.rawSha256);
    expect(() => computeDataVersion(makeRoot({}), ['2026-01-01'])).toThrow(/normalized file missing/);
  });
});

describe('golden results', () => {
  const o = original;
  const r = audited;
  it('pins the frozen reference strategy and the original result', () => {
    expect(o.strategyFingerprint).toBe(fingerprint(REF_IRON_CONDOR_SPEC));
    expect(o.strategyFingerprint.startsWith('e76741da1eea511a')).toBe(true);
    expect(o.netTotal).toBe(-69976.23);
    expect(o.trades).toBe(104);
    expect(o.brokeragePlanId).toBe('ZERODHA-FO-r2');
  });
  it('audited run differs from the original only in costs (r3 brokerage), on identical data', () => {
    expect(r.data).toEqual(o.data);
    expect(r.grossTotal).toBe(o.grossTotal);
    expect(r.perTrade.map((t) => t.grossPnL)).toEqual(o.perTrade.map((t) => t.grossPnL));
    // ₹20 + 18 % GST = ₹23.60 per OTM/ATM leg no longer charged at expiry.
    const legs = (r.netTotal - o.netTotal) / 23.6;
    expect(Math.abs(legs - Math.round(legs))).toBeLessThan(1e-6);
  });
  it('compareGolden reports nothing for itself and every changed field otherwise', () => {
    expect(compareGolden(o, o)).toEqual([]);
    const d = compareGolden(o, r);
    expect(d).toContain('brokeragePlanId: expected ZERODHA-FO-r2, got ZERODHA-FO-r3');
    expect(d.some((x) => x.startsWith('netTotal'))).toBe(true);
    const missing = { ...o, perTrade: o.perTrade.slice(1) };
    expect(compareGolden(o, missing)).toContain(`trade ${o.perTrade[0].id}: missing`);
  });
});
