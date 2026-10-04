/**
 * REFERENCE strategy for exercising the backtest engine. It is deliberately
 * plain and its parameters were fixed before any backtest was run; they must
 * not be tuned to historical results. It is NOT a recommendation.
 *
 * Rule (evaluated on the evening of each NIFTY weekly expiry day D):
 *   - S = NIFTY underlying price in D's bhavcopy; E = next listed NIFTY expiry after D.
 *   - Short put  = highest listed PE strike ≤ 0.98·S
 *     Long put   = highest listed PE strike ≤ short put − 0.01·S
 *     Short call = lowest listed CE strike ≥ 1.02·S
 *     Long call  = lowest listed CE strike ≥ short call + 0.01·S
 *   - All four legs must have traded on D. 1 lot each.
 *   - Engine fills at the next trading day's close (with spread) and holds to E.
 */

import { StrategySpecSchema, fingerprint, type StrategySpec } from '../strategy-spec.js';
import type { EodStrategy, EveningContext, NoTrade, Proposal } from '../../backtest/eod-engine.js';
import type { BhavRecord } from '../../history/bhavcopy.js';

export const REF_IRON_CONDOR_SPEC: StrategySpec = StrategySpecSchema.parse({
  strategyId: 'ref_nifty_weekly_iron_condor',
  version: '1.0.0',
  status: 'BACKTEST',
  description:
    'Reference strategy to exercise the EOD backtest engine: weekly NIFTY short iron condor, shorts 2% OTM, ' +
    'wings 1% further, entered the trading day after an expiry, held to the next expiry. Not tuned; not a recommendation.',
  eligibleUnderlyings: ['NIFTY'],
  eligibleExpiries: { minDaysToExpiry: 1, maxDaysToExpiry: 10, weeklyAllowed: true, monthlyAllowed: true },
  structure: {
    template: 'iron_condor',
    definedRiskOnly: true,
    legs: [
      { type: 'PE', action: 'BUY', strikeRule: 'highest PE strike <= short put - 1% of spot', lots: 1 },
      { type: 'PE', action: 'SELL', strikeRule: 'highest PE strike <= 98% of spot', lots: 1 },
      { type: 'CE', action: 'SELL', strikeRule: 'lowest CE strike >= 102% of spot', lots: 1 },
      { type: 'CE', action: 'BUY', strikeRule: 'lowest CE strike >= short call + 1% of spot', lots: 1 },
    ],
  },
  entryConditions: [
    'Signal on the evening of a NIFTY weekly expiry day using that day\'s bhavcopy',
    'All four legs traded (volume > 0) on the signal day',
    'No position open',
  ],
  exitConditions: ['Hold to expiry; settle at the exchange final settlement price'],
  stopRules: ['None (defined risk; max loss = wing width - credit + costs)'],
  profitTakingRules: ['None (held to expiry)'],
  invalidationConditions: ['Any leg not listed or untraded on the fill day → trade skipped'],
  risk: { maxNetLossPerTradeRupees: 25000, maxLotsPerTrade: 1, maxConcurrentPositions: 1, expectedHoldingTime: '4-7 trading days' },
  liquidity: { minOpenInterestContracts: 0, maxBidAskSpreadPct: 1, minDataQuality: 'DEGRADED' },
  costAssumptions: {
    chargeScheduleIds: ['IN-NSE-FO-2024-10-01-r2', 'IN-NSE-FO-2026-04-01-r2'],
    brokeragePlanId: 'ZERODHA-FO-r2',
    slippageModel: 'EOD_PESSIMISTIC_V1 (half-spread = max(0.10, 2% of close))',
  },
  changelog: [{ version: '1.0.0', date: '2026-10-04', change: 'Initial reference definition, fixed before any backtest run' }],
});

const SYMBOL = 'NIFTY';

function strikes(rows: readonly BhavRecord[], expiry: string, type: 'CE' | 'PE'): BhavRecord[] {
  return rows
    .filter((r) => r.symbol === SYMBOL && r.expiry === expiry && r.optionType === type && r.strike !== null)
    .sort((a, b) => (a.strike as number) - (b.strike as number));
}

export function createRefIronCondor(): EodStrategy {
  return {
    id: REF_IRON_CONDOR_SPEC.strategyId,
    version: REF_IRON_CONDOR_SPEC.version,
    fingerprint: fingerprint(REF_IRON_CONDOR_SPEC),
    symbols: [SYMBOL],
    onEvening(ctx: EveningContext): Proposal | NoTrade | null {
      if (ctx.hasOpenPosition) return null;
      const opts = ctx.rows.filter((r) => r.symbol === SYMBOL && r.instrumentType === 'IDX_OPT');
      // Only on the evening of an expiry day.
      if (!opts.some((r) => r.expiry === ctx.date)) return null;
      const next = [...new Set(opts.map((r) => r.expiry))].filter((e) => e > ctx.date).sort()[0];
      // From here the rule applies tonight: any failure is reported as a reason, never silently dropped.
      if (!next) return { noTrade: 'No later NIFTY expiry listed' };
      const s = opts.find((r) => r.underlyingPrice !== null)?.underlyingPrice;
      if (!s) return { noTrade: 'No NIFTY underlying value in the bhavcopy' };

      const traded = (r: BhavRecord | undefined) => !!r && (r.volumeContracts ?? 0) > 0 && (r.close ?? 0) > 0;
      const puts = strikes(opts, next, 'PE');
      const calls = strikes(opts, next, 'CE');
      const shortPut = [...puts].reverse().find((r) => (r.strike as number) <= 0.98 * s);
      const longPut = shortPut && [...puts].reverse().find((r) => (r.strike as number) <= (shortPut.strike as number) - 0.01 * s);
      const shortCall = calls.find((r) => (r.strike as number) >= 1.02 * s);
      const longCall = shortCall && calls.find((r) => (r.strike as number) >= (shortCall.strike as number) + 0.01 * s);
      const legs = { 'long put': longPut, 'short put': shortPut, 'short call': shortCall, 'long call': longCall };
      const bad = Object.entries(legs).filter(([, r]) => !traded(r || undefined));
      if (bad.length) {
        return { noTrade: `Leg(s) not listed or untraded on ${ctx.date} for ${next}: ${bad.map(([k, r]) => (r ? `${k} ${r.strike}` : `${k} (no strike)`)).join(', ')}` };
      }

      return {
        symbol: SYMBOL,
        expiry: next,
        reason: `Expiry-day evening ${ctx.date}: NIFTY ${s}; condor for ${next}`,
        legs: [
          { type: 'PE', strike: longPut!.strike as number, side: 'BUY', lots: 1 },
          { type: 'PE', strike: shortPut!.strike as number, side: 'SELL', lots: 1 },
          { type: 'CE', strike: shortCall!.strike as number, side: 'SELL', lots: 1 },
          { type: 'CE', strike: longCall!.strike as number, side: 'BUY', lots: 1 },
        ],
      };
    },
  };
}
