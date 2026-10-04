/**
 * Experiment registry: append-only hash chain, tamper detection, and the committed registry.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendExperiment, readRegistry, verifyRegistry, trialsFor, type Experiment } from '../research/experiment-registry.js';

const H64 = 'a'.repeat(64);
const exp = (id: string): Experiment => ({
  id, registeredAt: '2026-10-04T00:00:00Z', kind: 'HYPOTHESIS_TEST', hypothesis: 'A test hypothesis long enough',
  strategy: { id: 's', version: '1.0.0', fingerprint: H64 },
  data: { from: '2024-10-01', to: '2026-10-01', days: 495, rawSha256: H64, normalizedSha256: H64 },
  costModel: { brokeragePlanId: 'ZERODHA-FO-r3', chargeScheduleIds: ['x'] },
  executionModel: { fill: 'next close', spreadModel: 'EOD_PESSIMISTIC_V1' },
  periods: { development: 'a', outOfSample: 'b' }, parameters: { k: 1 },
  decisionRule: 'fixed before running the test', result: null, decision: 'PENDING', goldenFile: null, notes: [],
});

describe('experiment registry', () => {
  it('chains entries and refuses duplicates', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'reg-')), 'e.jsonl');
    appendExperiment(f, exp('EXP-0001'));
    appendExperiment(f, exp('EXP-0002'));
    expect(verifyRegistry(readRegistry(f))).toEqual([]);
    expect(() => appendExperiment(f, exp('EXP-0002'))).toThrow(/already registered/);
    expect(trialsFor(readRegistry(f), 's')).toBe(2);
  });
  it('detects an edited, deleted or reordered entry and then refuses to append', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'reg-')), 'e.jsonl');
    for (const id of ['EXP-0001', 'EXP-0002', 'EXP-0003']) appendExperiment(f, exp(id));
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    writeFileSync(f, lines[0].replace('"PENDING"', '"SURVIVES"') + '\n' + lines.slice(1).join('\n') + '\n');
    expect(verifyRegistry(readRegistry(f)).join(' ')).toMatch(/hash mismatch/);
    expect(() => appendExperiment(f, exp('EXP-0004'))).toThrow(/not intact/);
    writeFileSync(f, [lines[0], lines[2]].join('\n') + '\n');
    expect(verifyRegistry(readRegistry(f)).join(' ')).toMatch(/chain broken|seq/);
  });
  it('the committed registry is intact and the reference strategy is REJECTED', () => {
    const entries = readRegistry(new URL('../../research/experiments.jsonl', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    expect(verifyRegistry(entries)).toEqual([]);
    const audited = entries.find((e) => e.id === 'EXP-0002');
    expect(audited?.result?.netTotal).toBe(-61008.23);
    // The foundation-audit entries; later experiments may have other decisions.
    expect(entries.filter((e) => /^EXP-000[1-5]$/.test(e.id)).map((e) => e.decision)).toEqual(Array(5).fill('REJECTED'));
  });
});

describe('pre-registration and linked RESULT entries', () => {
  const setup = () => {
    const f = join(mkdtempSync(join(tmpdir(), 'reg-')), 'e.jsonl');
    appendExperiment(f, exp('EXP-0001'));
    return f;
  };
  const result = (over: Partial<Experiment> = {}): Experiment => ({
    ...exp('EXP-0002'), kind: 'RESULT', resolves: 'EXP-0001', decision: 'REJECTED',
    result: { trades: 104, grossTotal: -1, costsTotal: 1, netTotal: -2, netExpectancy: -0.02, netExpectancyStdErr: 1, developmentNet: -1, outOfSampleNet: -1 },
    ...over,
  });

  it('accepts a RESULT that ran exactly what was pre-registered, and counts one trial', () => {
    const f = setup();
    appendExperiment(f, result());
    expect(verifyRegistry(readRegistry(f))).toEqual([]);
    expect(trialsFor(readRegistry(f), 's')).toBe(1);
  });
  it('refuses a RESULT whose run differs from the pre-registration (no moving the goalposts)', () => {
    const f = setup();
    expect(() => appendExperiment(f, result({ decisionRule: 'a looser rule written afterwards' }))).toThrow(/decisionRule differs/);
    expect(() => appendExperiment(f, result({ parameters: { k: 2 } }))).toThrow(/parameters differs/);
    expect(() => appendExperiment(f, result({ executionModel: { fill: 'other', spreadModel: 'EOD_ZERO_SPREAD' } }))).toThrow(/executionModel differs/);
  });
  it('refuses resolving twice, resolving unknown entries, or a RESULT without a decision', () => {
    const f = setup();
    appendExperiment(f, result());
    expect(() => appendExperiment(f, result({ id: 'EXP-0003' }))).toThrow(/already resolved/);
    expect(() => appendExperiment(f, result({ id: 'EXP-0004', resolves: 'EXP-0099' }))).toThrow(/unknown/);
    expect(() => appendExperiment(f, result({ id: 'EXP-0005', resolves: 'EXP-0002' }))).toThrow(/not a PENDING/);
    const g = setup();
    expect(() => appendExperiment(g, result({ decision: 'PENDING' }))).toThrow(/must carry a result and a decision/);
  });
  it('the committed EXP-0006 pre-registration is resolved by EXP-0007: REJECTED', () => {
    const entries = readRegistry(new URL('../../research/experiments.jsonl', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    const r = entries.find((e) => e.id === 'EXP-0007');
    expect(r).toMatchObject({ kind: 'RESULT', resolves: 'EXP-0006', decision: 'REJECTED' });
    expect(r?.result?.netTotal).toBe(-61313.06);
    expect(entries.findIndex((e) => e.id === 'EXP-0006')).toBeLessThan(entries.findIndex((e) => e.id === 'EXP-0007'));
  });
});
