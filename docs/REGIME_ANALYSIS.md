# Regime Analysis (Foundation Phase 9)

Date: 2026-10-04. Subject: `ref_nifty_weekly_iron_condor` v1.0.0, audited run (EXP-0002), 104 trades.
Module `src/analytics/regime.ts`; reproduce with `node dist/foundation-analysis-cli.mjs`.

## Rules of this analysis

- Thresholds were **declared in code before any regime result was computed** (`REGIME_THRESHOLDS`,
  declared 2026-10-04) and are not to be changed after seeing results.
- **Ex-ante** labels use only data up to the signal evening (realized volatility, trend, expiry type).
  **Ex-post** labels use the holding period and only describe what happened; they can never be
  turned into an entry rule.
- Buckets with fewer than 20 trades are marked insufficient. **No trading rule is derived from this
  document.** A regime filter would be a new strategy and needs a pre-registered experiment
  (EXPERIMENT_PROTOCOL.md), judged against the trial count in the registry.
- VIX is not used: it is not in the stored data. Realized volatility comes from the NIFTY underlying
  value in the bhavcopy (`UndrlygPric`).

| Label | Definition |
|---|---|
| LOW / MID / HIGH_VOL | 20-day annualized close-to-close realized vol at the signal: < 12 %, 12–18 %, > 18 % |
| UP / FLAT / DOWN | 20-day underlying return at the signal: > +3 %, between, < −3 % |
| MONTHLY / WEEKLY | Traded expiry is / is not the last NIFTY expiry of its month |
| Expiry weekday | Day of week of the traded expiry (Thursday before Sept 2025, Tuesday after; holidays shift some) |
| LARGE_MOVE (ex-post) | Any daily underlying move ≥ 1.5 % between entry and expiry |

## Results (net)

| Regime | Label | Trades | Net | Mean / trade | Win rate | Worst | n ≥ 20 |
|---|---|---:|---:|---:|---:|---:|---|
| vol | LOW_VOL | 50 | −₹8,878.02 | −₹177.56 | 82 % | −₹17,807.26 | yes |
| vol | MID_VOL | 38 | −₹23,783.42 | −₹625.88 | 71 % | −₹15,485.56 | yes |
| vol | HIGH_VOL | 16 | −₹28,346.79 | −₹1,771.67 | 56 % | −₹15,307.37 | no |
| trend | UP | 11 | −₹18,060.23 | −₹1,641.84 | 73 % | −₹15,485.56 | no |
| trend | FLAT | 74 | −₹26,222.20 | −₹354.35 | 78 % | −₹17,807.26 | yes |
| trend | DOWN | 19 | −₹16,725.80 | −₹880.31 | 58 % | −₹8,746.26 | no |
| expiry | MONTHLY | 24 | +₹1,795.64 | +₹74.82 | 79 % | −₹14,499.17 | yes |
| expiry | WEEKLY | 80 | −₹62,803.87 | −₹785.05 | 73 % | −₹17,807.26 | yes |
| weekday | Thursday | 45 | −₹16,015.64 | −₹355.90 | 78 % | −₹17,807.26 | yes |
| weekday | Tuesday | 53 | −₹12,800.44 | −₹241.52 | 77 % | −₹13,395.61 | yes |
| weekday | Monday / Wednesday (holiday-shifted) | 6 | −₹32,192.15 | −₹5,365.36 | 17 % | −₹15,485.56 | no |
| period | Development | 52 | −₹28,558.24 | −₹549.20 | 77 % | −₹17,807.26 | yes |
| period | Out-of-sample | 52 | −₹32,449.99 | −₹624.04 | 71 % | −₹13,481.86 | yes |
| ex-post | LARGE_MOVE in holding | 17 | −₹86,651.46 | −₹5,097.14 | 29 % | −₹15,485.56 | no |
| ex-post | NO_LARGE_MOVE | 87 | +₹25,643.23 | +₹294.75 | 83 % | −₹17,807.26 | yes |

## Reading

1. **Negative in every ex-ante regime with enough trades.** Low-vol, mid-vol, flat-trend, Thursday,
   Tuesday, development and out-of-sample buckets are all net negative. There is no regime in which
   the strategy, as specified, shows a positive edge with adequate sample size.
2. **Monthly expiries are not evidence of an edge.** +₹74.82 ± ₹805 per trade (n = 24) against
   −₹785 ± ₹561 for weekly expiries; the difference is within about one standard error. Picking the
   monthly bucket now would be data mining. It is recorded here, not acted on.
3. **The loss comes from large moves.** Trades with a ≥ 1.5 % daily move while open lost ₹86,651 in
   total; the rest made ₹25,643. This is ex-post: it explains the result and cannot be used to select
   trades in advance. It also shows the premium collected (≈ ₹2,278 per trade) does not pay for the
   observed frequency of large moves at these strike distances.
4. **Higher realized volatility at entry was worse, not better.** Higher premiums did not compensate
   (HIGH_VOL mean −₹1,772, n = 16, insufficient). Do not read this as a filter.
5. **Holiday-shifted expiries** (6 trades on Monday/Wednesday) lost ₹32,192. n = 6, so nothing can
   be concluded. It is noted because those weeks change holding length, and should be checked if a
   future strategy depends on expiry timing.

## Caveats

- Lot size changed (25 → 75 → 65 units) during the sample, so rupee totals by regime mix different
  position sizes.
- Two years is one market history. The regimes overlap in time, and one shock week can move several
  buckets at once.
- No multiple-comparison correction is applied, because no hypothesis is being tested here. With 15+
  buckets, at least one would look "significant" by chance.
