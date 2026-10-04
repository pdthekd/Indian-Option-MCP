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
