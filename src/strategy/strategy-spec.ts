/**
 * @module strategy/strategy-spec
 *
 * Strategies are versioned, declarative data validated by this schema — never
 * rules invented at runtime. Any change to a field requires a new `version`;
 * `fingerprint()` lets the system detect a silently edited spec.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const StrategySpecSchema = z.object({
  strategyId: z.string().regex(/^[a-z0-9_]{3,48}$/),
  version: Semver,
  status: z.enum(['DRAFT', 'BACKTEST', 'PAPER', 'SHADOW', 'RETIRED']), // no LIVE status exists in this build
  description: z.string().min(10).max(2000),
  eligibleUnderlyings: z.array(z.string().min(1).max(32)).min(1),
  eligibleExpiries: z.object({
    minDaysToExpiry: z.number().min(0),
    maxDaysToExpiry: z.number().positive(),
    weeklyAllowed: z.boolean(),
    monthlyAllowed: z.boolean(),
  }),
  structure: z.object({
    template: z.string().min(1),
    definedRiskOnly: z.literal(true),
    legs: z.array(z.object({
      type: z.enum(['CE', 'PE']),
      action: z.enum(['BUY', 'SELL']),
      strikeRule: z.string().min(1).max(200),
      lots: z.number().int().min(1).max(10),
    })).min(1).max(8),
  }),
  entryConditions: z.array(z.string().min(1).max(300)).min(1),
  exitConditions: z.array(z.string().min(1).max(300)).min(1),
  stopRules: z.array(z.string().min(1).max(300)).min(1),
  profitTakingRules: z.array(z.string().min(1).max(300)).min(1),
  invalidationConditions: z.array(z.string().min(1).max(300)).min(1),
  risk: z.object({
    maxNetLossPerTradeRupees: z.number().positive(),
    maxLotsPerTrade: z.number().int().min(1),
    maxConcurrentPositions: z.number().int().min(1),
    expectedHoldingTime: z.string().min(1).max(100),
  }),
  liquidity: z.object({
    minOpenInterestContracts: z.number().int().min(0),
    maxBidAskSpreadPct: z.number().positive().max(1),
    minDataQuality: z.enum(['FULL', 'DEGRADED']),
  }),
  costAssumptions: z.object({
    chargeScheduleIds: z.array(z.string()).min(1),
    brokeragePlanId: z.string(),
    slippageModel: z.string().min(1),
  }),
  changelog: z.array(z.object({ version: Semver, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), change: z.string().min(1) })).min(1),
}).strict();

export type StrategySpec = z.infer<typeof StrategySpecSchema>;

/** Stable SHA-256 of the canonical spec (keys sorted). */
export function fingerprint(spec: StrategySpec): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return createHash('sha256').update(JSON.stringify(canon(spec))).digest('hex');
}

/**
 * Registry that refuses to change an existing (id, version) silently.
 */
export class StrategyRegistry {
  private readonly specs = new Map<string, { spec: StrategySpec; fp: string }>();

  register(raw: unknown): StrategySpec {
    const spec = StrategySpecSchema.parse(raw);
    const key = `${spec.strategyId}@${spec.version}`;
    const fp = fingerprint(spec);
    const existing = this.specs.get(key);
    if (existing && existing.fp !== fp) {
      throw new Error(`${key} already registered with different content. Bump the version.`);
    }
    if (spec.changelog[spec.changelog.length - 1].version !== spec.version) {
      throw new Error(`${key}: last changelog entry must describe version ${spec.version}`);
    }
    this.specs.set(key, { spec, fp });
    return spec;
  }

  get(strategyId: string, version: string): StrategySpec {
    const e = this.specs.get(`${strategyId}@${version}`);
    if (!e) throw new Error(`Unknown strategy ${strategyId}@${version}`);
    return e.spec;
  }
}
