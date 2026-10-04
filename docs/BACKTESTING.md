# Backtesting (Phases 11, 12, 15, 16)

## Status

An **end-of-day (EOD) backtest engine** exists and has run one deliberately plain **reference
strategy** over two years of real NSE data. No intraday backtesting is possible yet (no
intraday option history source). **No strategy has been validated.**

```bash
npm run build
node dist/bhavcopy-cli.mjs --from 2024-10-01 --to <date>   # if newer data is needed
node dist/backtest-cli.mjs                                 # writes ~/.options-hq/data/backtests/*.md|json
npm run backtest:verify                                    # must reproduce the audited golden result exactly
```

Options: `--brokerage-plan` (default `ZERODHA-FO-r3`), `--spread-model` (default `EOD_PESSIMISTIC_V1`;
others are for sensitivity only), `--write-golden <file>`, `--verify <golden file>`.

## What the engine does (src/backtest/eod-engine.ts)

| Rule | Why |
|---|---|
| On day D the strategy sees only D's bhavcopy (published after the close) | No look-ahead (tested) |
| Orders fill at the **next** trading day's close, never the close that triggered them | You cannot trade at a close you have not seen yet |
| Every fill pays a half-spread against the order: `EOD_PESSIMISTIC_V1` = max(₹0.10, 2% of close) | No historical bid/ask exists; to be calibrated from the quote recorder |
| A leg not listed, untraded, or with no close on the fill day ⇒ whole trade skipped and recorded | No phantom fills |
| Exact per-contract lot size from the fill day's bhavcopy | Lot sizes change by trade date |
| Entry costs from the TransactionCostEngine; expiry exercise STT and settlement brokerage via the PnLEngine | One cost source of truth |
| Settlement at the exchange final settlement price from the expiry-day bhavcopy (`SttlmPric` of expiring options) | Works for weekly expiries |
| One position at a time, fixed 1 lot, no compounding | No sizing effects hiding the edge |
| Dates without a charge schedule (before 2024-10-01) throw | Fail closed |
| A missing expected trading day (weekday, not an official holiday) throws | No silent gaps |
| An open position whose expiry-day data is missing throws | No position silently survives expiry |
| Held legs are followed by NSE instrument id (`FinInstrmId`) every day; an expiry relabel is followed, a vanished contract throws | NSE relabels expiries of listed contracts (2025-08-01, 2025-12-29) |
| A strategy may return `{ noTrade: reason }`; reasons are recorded in `result.noTrade` | No silently dropped signals |
| Any day with a bhavcopy is a trading day, including Muhurat special sessions | Two reference trades filled in Muhurat sessions (FOUNDATION_AUDIT F14, open) |
| Every result records brokerage plan, spread model and a data version (sha256 of raw and normalized files) | Exact reproducibility |

Reports (`src/backtest/report.ts`): GROSS / COSTS / NET; net expectancy ± standard error, win rate,
average net win/loss, profit factor, drawdown, losing streak; a **development / out-of-sample** split
at the date-range midpoint (fixed by the range, not by results); BASE / WORSE / SEVERE cost sensitivity
and break-evens. Verdicts: `UNKNOWN` below 100 trades or when not distinguishable from zero on the
positive side; `NEGATIVE NET EXPECTANCY` when the mean net result is ≤ 0 (a conservative point-estimate
rule, **not** a significance claim).

## First run: reference strategy (2026-10-04)

`ref_nifty_weekly_iron_condor` v1.0.0 (src/strategy/reference): on each NIFTY weekly expiry evening,
sell the next weekly iron condor — shorts 2% OTM, wings 1% further, 1 lot, held to expiry. Parameters
were fixed before the run and **must not be tuned to this result**. It exists to exercise the engine,
not as a recommendation.

Data: 2024-10-01 → 2026-10-01, 495 trading days, 104 trades, 0 skipped.

| | All | Development (before 2025-10-01) | Out-of-sample |
|---|---:|---:|---:|
| Trades | 104 | 52 | 52 |
| Gross P&L | −₹34,259.75 | −₹16,325.00 | −₹17,934.75 |
| Costs (charges + spread) | ₹35,716.48 | ₹16,717.24 | ₹18,999.24 |
| **Net P&L** | **−₹69,976.23** | **−₹33,042.24** | **−₹36,933.99** |
| Net expectancy / trade | −₹672.85 ± ₹468.43 | −₹635.43 ± ₹742.73 | −₹710.27 ± ₹578.44 |
| Net win rate | 73.1% | 76.9% | 69.2% |
| Avg net win / loss | ₹1,598.55 / −₹6,838.08 | | |
| Max drawdown (net) | ₹76,006.42 | | |

Reading it plainly:

- The strategy **lost money before costs** (gross −₹329 per trade) and costs (₹343 per trade) doubled the loss.
- A **73% win rate with a net loss**: many small wins, a few large losses. A high win rate is not an edge.
- The loss is not statistically significant (mean −₹673, standard error ₹468); the honest summary is
  "no evidence of a positive edge; point estimate negative", consistently in both halves.
- It fails in every cost scenario (WORSE −₹95,164; SEVERE −₹1,20,352). Break-even would need an 81% win
  rate at the observed win/loss sizes.
- One trade (expiry 2025-07-17) was checked by hand against the raw bhavcopy: strikes, closes, fills,
  lot size, settlement and gross P&L all match.
- About ₹86 per trade of these costs was settlement brokerage on options that expire worthless. The
  Foundation audit found Zerodha does not charge it and corrected the plan (next section).

## Foundation audit re-run (2026-10-04)

The original run used brokerage plan `ZERODHA-FO-r2`, which charged ₹20 + GST settlement brokerage on
legs expiring worthless. The audited run uses `ZERODHA-FO-r3` (ITM exercised/assigned only). Strategy,
data (same hashes), fills and gross are identical; only costs change.

| | Original (EXP-0001, r2) | Audited (EXP-0002, r3) |
|---|---:|---:|
| Gross P&L | −₹34,259.75 | −₹34,259.75 |
| Costs | ₹35,716.48 | ₹26,748.48 |
| **Net P&L** | **−₹69,976.23** | **−₹61,008.23** |
| Net expectancy / trade | −₹672.85 ± ₹468.43 | −₹586.62 ± ₹469.54 |
| Development / out-of-sample net | −₹33,042.24 / −₹36,933.99 | −₹28,558.24 / −₹32,449.99 |
| WORSE / SEVERE cost scenario | −₹95,164 / −₹1,20,352 | −₹81,712.30 / −₹1,02,416.38 |
| Verdict | NEGATIVE NET EXPECTANCY | NEGATIVE NET EXPECTANCY |

Difference: exactly 380 worthless legs × ₹23.60 = ₹8,968.00. Both results are frozen as golden files
in `src/strategy/reference/golden/`, reproduced exactly by `npm run backtest:verify` /
`backtest:verify-original`, and independently re-computed from the raw NSE zips by
`scripts/verify_reference.py` (separate Python implementation; all 104 trades match to the paisa).
Analyses: COST_MODEL_AUDIT.md, EXECUTION_CALIBRATION.md, TAIL_LOSS_ANALYSIS.md, REGIME_ANALYSIS.md,
FOUNDATION_AUDIT.md.

## Still required before any strategy result is trusted

1. Calibrate the spread model from the quote recorder's real bid/ask (weeks of data).
2. Intraday option data for anything not decided once a day.
3. Verify post-2026-04-01 charges and expiry settlement charges on a real contract note.
4. Real broker margin (only a SPAN proxy exists) and intraday drawdown (only EOD marks exist).
5. Walk-forward over more regimes, parameter-perturbation and Monte Carlo trade-sequence tests
   (Phase 16) once a candidate strategy exists.
