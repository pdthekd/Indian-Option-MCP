# Experiment Protocol (Foundation Phase 10)

Date: 2026-10-04. This protocol governs every backtest or research result that could influence a
trading decision. It exists because, with enough tries, any data set "contains" a profitable
strategy. The defence is to fix decisions **before** looking, record **every** try, and keep the
answer "no trade" always available.

There is **no optimizer** in this repository and none is to be added during the research phase.

## 1. Registry first

Every experiment is registered in `research/experiments.jsonl` (append-only, hash-chained;
`src/research/experiment-registry.ts`; CLI `node dist/experiments-cli.mjs verify|list|register`).
Failed, abandoned and sensitivity runs are registered too. Editing or deleting a past entry breaks
the chain, and `verify` and the test suite report it.

Each entry records:

| Field | Content |
|---|---|
| hypothesis | One falsifiable sentence, stated in NET terms |
| strategy | id, version, spec fingerprint (sha256 of the frozen spec) |
| data | date range, number of days, sha256 of raw zips and of normalized files |
| costModel | brokerage plan id, charge schedule ids |
| executionModel | fill rule, spread model id |
| periods | development and out-of-sample ranges (fixed by date, not by results) |
| parameters | every parameter value |
| decisionRule | the SURVIVES / REJECTED / INCONCLUSIVE rule, written before the run |
| result | trades, gross, costs, net, net expectancy ± SE, development and OOS net |
| decision | PENDING → one of SURVIVES / REJECTED / INCONCLUSIVE / ABANDONED |
| goldenFile | frozen per-trade result, if the run is to be reproducible exactly |

Current registry: EXP-0001 (original reference run, r2), EXP-0002 (audited re-run, r3) and
EXP-0003..0005 (spread sensitivity). All are REJECTED. EXP-0001's decision rule was written after
the run, and its entry says so.

## 2. Standard decision rule

Unless a stricter rule is registered in advance:

- **SURVIVES** only if all hold: ≥ 100 trades; net expectancy > 0 in both the development and the
  out-of-sample halves; overall net expectancy > 2 standard errors above zero; net total > 0 under
  the WORSE cost scenario (brokerage ×1.5, statutory and exchange ×1.25, spread ×2).
- **REJECTED** if net expectancy ≤ 0 overall and in both halves.
- **INCONCLUSIVE** otherwise. INCONCLUSIVE is not a weak SURVIVES, and it never justifies capital.

SURVIVES only earns a strategy the next stage (paper → shadow), never live trading.

## 3. Anti-overfitting rules

1. **Freeze before testing.** Spec, parameters, cost plan, spread model, date range and decision rule
   are fixed and fingerprinted before the first run. Any change creates a new version and a new entry.
2. **No tuning on the result.** Parameters are not adjusted in response to a backtest. "Try 2.5 %
   instead of 2 %" is a new experiment, and it counts as a trial.
3. **Count the trials.** `trialsFor()` gives the number of registered trials per strategy family. A
   result found after N trials is judged against N: report it, and require out-of-sample confirmation
   on data **not yet recorded** (forward / shadow), not just on the held-out half.
4. **Out-of-sample is used once.** After the OOS half has been looked at for a strategy family, it is
   development data for every later variant of that family.
5. **Pre-declared thresholds.** Regime and filter thresholds are declared in code with a date before
   results are computed (see `REGIME_THRESHOLDS`, `CALIBRATION_RULE`).
6. **Ex-post labels never become rules.** Anything that uses information after entry (holding-period
   move, settlement outcome) only describes results.
7. **Costs never move in the strategy's favour without evidence.** Cost or spread models change only
   on a cited source or a reconciled contract note / calibrated quote sample, never because the
   result improves. Each change keeps the old model selectable and the old golden result reproducible.
8. **Report NET, show GROSS.** Gross P&L is never reported as profit. Win rate is never reported
   without average win, average loss and the worst trades.
9. **Sensitivity is not selection.** Spread, cost and parameter grids are robustness checks. The
   best cell of a grid is not a result.
10. **NO TRADE is a valid outcome** of every experiment, and the default one.

## 4. Reproducibility

From a clean checkout:

```bash
npm ci --ignore-scripts
npm run build
node dist/bhavcopy-cli.mjs --from 2024-07-08 --to 2026-10-01   # downloads raw NSE files (~555 days)
npm run backtest:verify             # audited result, EXP-0002, must print VERIFY OK
npm run backtest:verify-original    # original result, EXP-0001 (superseded r2 plan)
python scripts/verify_reference.py --golden src/strategy/reference/golden/ref_iron_condor_v1.0.0_audited_r3_v1.json
```

`--verify` compares strategy fingerprint, cost plan, spread model, data hashes and every trade's
gross, costs, spread and net to the paisa, and exits non-zero on any difference. If NSE ever
republishes a file, the data hash changes and verification fails loudly instead of silently giving a
different number. `scripts/verify_reference.py` is an independent implementation (Python, raw zips,
no shared code) and currently matches all 104 trades of both golden files exactly.

## 5. Stages after research

| Stage | Entry condition | Exit condition |
|---|---|---|
| Backtest | Registered experiment | SURVIVES under §2 |
| Paper (PaperBroker, RiskGateway, journal) | SURVIVES | ≥ 8 weeks of paper results consistent with the backtest net |
| Shadow (real quotes, hypothetical orders) | Paper consistent | Shadow fills vs model within the calibrated spread; ≥ 8 weeks |
| Live pilot | See LIVE_TRADING_READINESS.md: every gate, human approval, code change | — |

No stage may be skipped, and the result of each stage is registered.
