/**
 * Append-only, hash-chained experiment registry (research/experiments.jsonl).
 *
 * Every backtest experiment — including failed and abandoned ones — is registered with the
 * fingerprints needed to reproduce it and the decision rule fixed BEFORE it ran. The chain makes
 * silent deletion or editing of past entries detectable, and the entry count is the number of
 * trials any later "discovery" must be judged against (docs/EXPERIMENT_PROTOCOL.md).
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const ExperimentSchema = z.object({
  id: z.string().regex(/^EXP-\d{4}$/),
  registeredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
  kind: z.enum(['REFERENCE_RUN', 'AUDIT_RERUN', 'SENSITIVITY', 'HYPOTHESIS_TEST', 'RESULT']),
  /**
   * For kind RESULT only: the id of an earlier PENDING entry (the pre-registration) this result
   * resolves. The registry is append-only, so pre-registration and result are two linked entries.
   */
  resolves: z.string().regex(/^EXP-\d{4}$/).optional(),
  hypothesis: z.string().min(10),
  strategy: z.object({ id: z.string(), version: z.string(), fingerprint: z.string().length(64) }),
  data: z.object({ from: z.string(), to: z.string(), days: z.number().int().positive(), rawSha256: z.string().length(64), normalizedSha256: z.string().length(64) }),
  costModel: z.object({ brokeragePlanId: z.string(), chargeScheduleIds: z.array(z.string()).min(1) }),
  executionModel: z.object({ fill: z.string(), spreadModel: z.string() }),
  periods: z.object({ development: z.string(), outOfSample: z.string() }),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  decisionRule: z.string().min(10),
  result: z.object({
    trades: z.number().int().nonnegative(),
    grossTotal: z.number(),
    costsTotal: z.number(),
    netTotal: z.number(),
    netExpectancy: z.number(),
    netExpectancyStdErr: z.number(),
    developmentNet: z.number(),
    outOfSampleNet: z.number(),
  }).nullable(),
  decision: z.enum(['PENDING', 'REJECTED', 'INCONCLUSIVE', 'SURVIVES', 'ABANDONED']),
  goldenFile: z.string().nullable(),
  notes: z.array(z.string()),
});
export type Experiment = z.infer<typeof ExperimentSchema>;
export type RegistryEntry = Experiment & { seq: number; prevHash: string; hash: string };

const GENESIS = '0'.repeat(64);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function entryHash(e: Omit<RegistryEntry, 'hash'>): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}

export function readRegistry(file: string): RegistryEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as RegistryEntry);
}

/** Every integrity problem in the registry; empty = intact. */
export function verifyRegistry(entries: readonly RegistryEntry[]): string[] {
  const errs: string[] = [];
  let prev = GENESIS;
  const ids = new Set<string>();
  entries.forEach((e, i) => {
    const { hash, ...rest } = e;
    const parsed = ExperimentSchema.safeParse(Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'seq' && k !== 'prevHash')));
    if (!parsed.success) errs.push(`entry ${i}: schema: ${parsed.error.issues[0]?.message}`);
    if (e.seq !== i + 1) errs.push(`entry ${i}: seq ${e.seq}, expected ${i + 1}`);
    if (e.prevHash !== prev) errs.push(`entry ${i}: chain broken (prevHash mismatch)`);
    if (entryHash(rest) !== hash) errs.push(`entry ${i}: hash mismatch (edited?)`);
    if (ids.has(e.id)) errs.push(`entry ${i}: duplicate id ${e.id}`);
    ids.add(e.id);
    if (e.kind === 'RESULT') errs.push(...resultLinkErrors(entries.slice(0, i), e, i));
    else if (e.resolves) errs.push(`entry ${i}: only RESULT entries may resolve another entry`);
    prev = hash;
  });
  return errs;
}

/**
 * A RESULT must resolve an earlier PENDING pre-registration exactly once, and must have run what was
 * registered: same strategy, data, cost model, execution model, periods, parameters and decision rule.
 */
function resultLinkErrors(earlier: readonly RegistryEntry[], e: RegistryEntry, i: number): string[] {
  if (!e.resolves) return [`entry ${i}: RESULT without 'resolves'`];
  const pre = earlier.find((x) => x.id === e.resolves);
  if (!pre) return [`entry ${i}: resolves unknown or later entry ${e.resolves}`];
  const errs: string[] = [];
  if (pre.decision !== 'PENDING' || pre.result !== null) errs.push(`entry ${i}: ${e.resolves} is not a PENDING pre-registration`);
  if (earlier.some((x) => x.kind === 'RESULT' && x.resolves === e.resolves)) errs.push(`entry ${i}: ${e.resolves} already resolved`);
  for (const k of ['strategy', 'data', 'costModel', 'executionModel', 'periods', 'parameters', 'decisionRule'] as const) {
    if (canonical(pre[k]) !== canonical(e[k])) errs.push(`entry ${i}: ${k} differs from pre-registration ${e.resolves}`);
  }
  if (e.result === null || e.decision === 'PENDING') errs.push(`entry ${i}: RESULT must carry a result and a decision`);
  return errs;
}

export function appendExperiment(file: string, exp: Experiment): RegistryEntry {
  const entries = readRegistry(file);
  const errs = verifyRegistry(entries);
  if (errs.length) throw new Error(`Registry is not intact; refusing to append: ${errs[0]}`);
  const parsed = ExperimentSchema.parse(exp);
  if (entries.some((e) => e.id === parsed.id)) throw new Error(`Experiment ${parsed.id} already registered`);
  if (parsed.kind === 'RESULT') {
    const probe = { ...parsed, seq: entries.length + 1, prevHash: '', hash: '' } as RegistryEntry;
    const errs = resultLinkErrors(entries, probe, entries.length);
    if (errs.length) throw new Error(`Invalid RESULT: ${errs.join('; ')}`);
  }
  const base = { ...parsed, seq: entries.length + 1, prevHash: entries.length ? entries[entries.length - 1].hash : GENESIS };
  const entry: RegistryEntry = { ...base, hash: entryHash(base) };
  appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/** Number of registered trials of a strategy family (all versions), for multiple-testing awareness. */
export function trialsFor(entries: readonly RegistryEntry[], strategyId: string): number {
  // A RESULT completes its pre-registration; it is not another trial.
  return entries.filter((e) => e.strategy.id === strategyId && e.kind !== 'SENSITIVITY' && e.kind !== 'RESULT').length;
}
