# Execution Calibration (Foundation Phase 5)

Date: 2026-10-04.

## Status: NOT CALIBRATED — no recorded quote data yet

The quote recorder (`src/history/quote-recorder.ts`, scheduled Windows task) records live NIFTY /
BANKNIFTY option bid/ask during market hours. Its first session is **Monday 2026-10-05**. As of this
audit there are **0 sessions and 0 quotes**, so the spread model cannot be calibrated and the
backtest continues to use the unverified, deliberately pessimistic assumption:

> `EOD_PESSIMISTIC_V1`: half-spread = max(₹0.10, 2 % of the bhavcopy close), rounded against the
> trader to the ₹0.05 tick.

Readiness is checked automatically by `node dist/foundation-analysis-cli.mjs` (section
"Spread calibration readiness") using `src/analytics/spread-calibration.ts`.

## What the fill model is, and what it is not

| Fact | Consequence |
|---|---|
| Fills are at the **next trading day's close** after the signal | No look-ahead (the signal used only the signal day's bhavcopy; tested) |
| For options, the bhavcopy `ClsPric` is a **weighted average of late-session trades**, not a tradable bid/ask | Even a perfect spread model is applied to a reference price nobody could trade at exactly |
| The leg must have traded (volume > 0) on the fill day, otherwise the whole trade is skipped | No phantom fills; 0 trades were skipped in the reference run |
| Spread is charged on entry only; the position settles at the exchange settlement price | No exit spread exists for held-to-expiry trades (correct for this strategy, not in general) |
| One lot; no market impact or queue modelled | Not valid for size |

## How much the spread assumption matters (reference strategy, r3 charges)

| Spread model | Spread cost | Net |
|---|---:|---:|
| EOD_ZERO_SPREAD (fill at close; impossible) | ₹0 | −₹45,903.80 |
| EOD_ONE_TICK (₹0.05 half-spread) | ₹1,352.00 | −₹47,255.05 |
| **EOD_PESSIMISTIC_V1 (default)** | **₹15,118.25** | **−₹61,008.23** |
| EOD_PESSIMISTIC_V1_X2 (stress) | ₹29,754.50 | −₹75,631.24 |

The reference strategy is net negative under **every** spread assumption, including the impossible
zero-spread case, because its gross result (−₹34,259.75) is negative. The calibration question is
therefore not decisive for this strategy, but it will be for any strategy whose gross is positive.
These alternative models exist for sensitivity analysis only (registered as EXP-0003..0005).

## Pre-registered calibration rule (fixed before any quote was recorded)

A calibrated model may replace `EOD_PESSIMISTIC_V1` only when **all** of the following hold
(`CALIBRATION_RULE` in `src/analytics/spread-calibration.ts`):

1. ≥ 20 recording sessions, including ≥ 1 expiry day and ≥ 1 day with a NIFTY move ≥ 1 %.
2. Only quotes stamped 15:00–15:30 IST are used (the window an EOD close-based fill represents).
3. Quotes must be two-sided, bid > 0, ask ≥ bid, data quality FULL; everything else is rejected and counted.
4. Premium buckets ₹0–5, 5–20, 20–50, 50–150, 150+; a bucket is usable only with ≥ 200 valid quotes.
5. The model's half-spread for a bucket is the **observed 75th percentile**, never below the median.
6. The reference backtest is re-run with the new model as a **new registered experiment**; the old
   result and golden files remain.

The model is chosen by this rule, not by which spread gives the best P&L. A calibration that
produces a *smaller* spread than V1 is accepted only through this rule; one that produces a larger
spread is accepted the same way.

## Close vs quote measurement (added 2026-10-04)

The EOD backtest fills at the bhavcopy close ± V1. That close is a weighted average of late trades,
so the right question is not only "how wide is the spread" but "how far was the close from the bid
and ask you could actually have traded". For every recorded contract, `src/analytics/close-gap.ts`
takes the **last snapshot stamped 15:20–15:30 IST** and that day's bhavcopy close C (traded
contracts only), then measures:

- buy cost = ask − C (what a buyer really paid above the reference),
- sell cost = C − bid (what a seller really gave up below it),

and compares both with the V1 half-spread at C, by premium bucket. It also reports how often V1
covers both sides and how often C lies inside the quote. Run after the day's bhavcopy is downloaded:

```bash
node dist/bhavcopy-cli.mjs --from <date> --to <date>
node dist/calibration-cli.mjs     # writes ~/.options-hq/data/calibration/calibration-report.{md,json}
```

This is measurement only. Any change to the fill model still goes through the pre-registered rule
above.

**Automated (2026-10-04):** a Windows scheduled task, *Options HQ Evening Calibration*, runs on
weekdays at 19:30 IST. It runs `~/.options-hq/run-evening.cmd` (outside the repository), which calls
`bhavcopy-cli --last 7` and then `calibration-cli`. Days already stored are reused, so a bhavcopy NSE
had not yet published at 19:30 is fetched on the next run. Output goes to
`~/.options-hq/data/calibration/` (report and `evening.log`). It is read-only and places no orders.

## Still not addressed by calibration

- Quotes are top-of-book snapshots polled about once a minute (NSE refresh rate not yet known), not
  executions. Shadow trading, which records the price a real order would have got, remains the final check.
- Intraday strategies need intraday option history, which is not available.
- Spreads widen in fast markets; the 75th percentile is chosen partly for that, but it is still a
  sample of calm and normal days until a stressed session is recorded.
