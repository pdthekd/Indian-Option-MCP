# Foundation Audit & Validation

Date: 2026-10-04. Branch `audit/foundation`. Subject: the research/backtest foundation of this
repository, and the frozen reference strategy `ref_nifty_weekly_iron_condor` v1.0.0.
No real-money order was placed. Live trading remains disabled.

## Decisions

| Gate | Decision |
|---|---|
| **Foundation** (can its results be trusted, within stated limits?) | **PASS WITH LIMITATIONS** |
| **Reference strategy** (does it have a positive net edge?) | **REJECTED** |

**Foundation: PASS WITH LIMITATIONS.**
- The engine's results reproduce exactly from a clean checkout, pinned by data hashes and golden files.
- They were independently re-computed by a separate implementation from the raw exchange files, to the paisa.
- The raw data passed an integrity audit of 18.5 million rows.
- Option charges reconcile with real contract notes.
- Five defects were found and fixed. Each one would have produced a silently wrong number or failed to fail closed.

The limitations (spread not calibrated, some charges not yet seen on a contract note, margin only a
proxy, end-of-day data only) are listed below. They bound what any result may claim. None affects
the strategy decision.

**Strategy: REJECTED** under the decision rule in EXPERIMENT_PROTOCOL.md §2:
- Net expectancy is negative overall (−₹586.62 ± ₹469.54 per trade) and in both halves (development −₹549.20, out-of-sample −₹624.04).
- The **gross** result is already negative (−₹34,259.75), so no cost or spread assumption can rescue it. Net stays negative even with an impossible zero spread (−₹45,903.80).
- It is negative in every regime bucket with ≥ 20 trades.

The correct action is **NO TRADE**. The −₹61,008 is not to be "recovered" by tuning this strategy.
Any variant is a new registered experiment, judged against the trial count.

## Phase 1: Freeze

| Item | Value |
|---|---|
| Strategy | `ref_nifty_weekly_iron_condor` v1.0.0, status BACKTEST |
| Spec fingerprint (sha256 of canonical spec) | `e76741da1eea511ad72875572ecdccb6adf72dc8318ef196b5ed3ad6b38752aa`, recomputed and matching |
| Rule | Evening of each NIFTY expiry: short put = highest strike ≤ 98 % S, long put ≤ short − 1 % S; short call = lowest ≥ 102 % S, long call ≥ short + 1 % S; next expiry; all legs traded on the signal day; 1 lot; fill at next close ± spread; hold to settlement |
| Spec vs implementation | Matches. Checked line by line, and independently re-implemented from the spec text in Python (identical 104 trades) |
| Data | 2024-10-01 → 2026-10-01, 495 trading days. Raw sha256 `1dec6fbd068c4f3b…`, normalized `223e2874f2f4eb7c…` |
| Golden files | `src/strategy/reference/golden/ref_iron_condor_v1.0.0_{original_r2,audited_r3}_v1.json` |

**Reported difference (not modified):** the frozen spec's `costAssumptions.brokeragePlanId` reads
`ZERODHA-FO-r2`. Changing it would change the fingerprint, so it stays. The audited run uses the
corrected plan r3 (Phase 3), and the plan actually used is recorded in each result, golden file and
registry entry. This is a cost-model correction, not a strategy change.

Spec limits that the backtest does not enforce never came into play:
- max net loss per trade (₹25,000; worst theoretical ₹22,433.93)
- holding period (≤ 8 trading days observed)
- liquidity and spread filters

## Phase 2: Engine audit

| Area | Check | Result |
|---|---|---|
| Data integrity | `scripts/audit_bhavcopy.py` over all 495 raw files, 18,461,009 rows: duplicates, trade-date mismatches, negative prices, OHLC consistency, lot sizes, uniqueness of the index value and expiry settlement per day | No problems in index options. 299 rows have a close outside the high/low range, all futures (293 stock, 6 index), where the close is a settlement-type price. Not used by the strategy |
| Gaps | Weekdays without a file | 28, all official NSE holidays. The engine now **throws** on any missing expected trading day |
| Look-ahead | Strategy sees only the signal day's rows (unit test); fills at the next close; regime lookbacks end at the signal | None found |
| Fill model | Next close ± half-spread, rounded to the ₹0.05 tick against the trader; legs must have traded on the fill day | As documented; 0 trades skipped |
| Contracts | Expiry, strike, type and lot size taken from the fill-day bhavcopy; settlement = `SttlmPric` of expiring options (all rows agree) | Correct; lot sizes 25 / 75 / 65 observed and applied by trade date |
| Expiry relabelling | NSE changed the listed expiry of long-dated NIFTY contracts mid-life (on 2025-08-01 for the Thursday→Tuesday switch, and on 2025-12-29 for a holiday) | No weekly trade affected. Since F6 was fixed, held contracts are tracked by `FinInstrmId` and relabels are followed |
| Independent P&L | `scripts/verify_reference.py`: Python, raw zips, no shared code, own charge schedules | **All 104 trades match both golden files to the paisa** (gross, costs, spread, net, settlement price, entry date) |
| Signals | 105 expiry evenings in range → 104 trades + 1 whose expiry falls after the range end | No signal silently dropped |

## Phase 3–4: Costs and contract notes

See COST_MODEL_AUDIT.md.
- Charges reconcile: model ₹8,624.23 vs ₹8,624.25 across 41 contract notes, with 40/41 notes exact on every component (`node dist/reconcile-cli.mjs`).
- Defect fixed: settlement brokerage was charged on options expiring worthless (plan r2 → r3, ₹8,968 over the run).
- Not yet seen on any contract note: charges after 2026-04-01, and expiry-settlement charges.

## Phase 5: Execution calibration

See EXECUTION_CALIBRATION.md. **No quotes have been recorded yet** (the first session is 2026-10-05).
The calibration rule is pre-registered. Spread stays `EOD_PESSIMISTIC_V1` until that rule is met.

## Phase 6: Re-run, original vs audited

| | Original (EXP-0001) | Audited (EXP-0002) | Reason for difference |
|---|---:|---:|---|
| Trades | 104 | 104 | — |
| Gross | −₹34,259.75 | −₹34,259.75 | — |
| Charges | ₹20,598.23 | ₹11,630.23 | r3: no brokerage on 380 worthless legs (380 × ₹23.60 = ₹8,968.00) |
| Spread | ₹15,118.25 | ₹15,118.25 | — |
| **Net** | **−₹69,976.23** | **−₹61,008.23** | as above |

Engine changes (gap check, unsettled-position check, 2024 holidays) changed no number: the run had
no gaps and no unsettled positions. Both results are reproducible (`npm run backtest:verify`,
`backtest:verify-original`).

Sensitivity (r3 charges): zero spread −₹45,903.80, one tick −₹47,255.05, V1 −₹61,008.23,
2×V1 −₹75,631.24. WORSE costs −₹81,712.30, SEVERE −₹1,02,416.38. No scenario is positive.

## Phase 7: Capital and margin (SPAN proxy, unverified)

| Metric | Value |
|---|---:|
| Max-loss margin per trade (widest wing × qty) | mean ₹17,300, max ₹22,500 |
| SPAN proxy (+ 2 % exposure on S × qty) | mean ₹49,079.19, max ₹61,807.95 |
| Capital utilization (days with a position) | 99.2 % |
| Max net drawdown | ₹70,366.02 |
| Sustaining capital (max blocked + max drawdown) | ₹1,32,173.97 |
| Return on sustaining capital | −23.1 % a year |

The real broker margin must be checked with the broker's basket-margin calculator before any paper
result is expressed as a return on capital. Module: `src/analytics/margin.ts`.

## Phase 8–9: Tail loss and regimes

See TAIL_LOSS_ANALYSIS.md and REGIME_ANALYSIS.md.
- The worst 10 trades make up 67 % of all losses. An average loss is about 4.2 average wins.
- 30 of 104 trades ended with a short strike in the money, and they lost more than the 74 full-profit trades made.
- No adequately-sized regime is positive. The monthly-expiry bucket (+₹75 ± ₹805, n = 24) is noise and is not acted on.

## Phase 10: Research lab

See EXPERIMENT_PROTOCOL.md.
- Hash-chained experiment registry (`research/experiments.jsonl`, EXP-0001..0005, all REJECTED).
- Standard decision rule and anti-overfitting rules.
- Pre-declared regime thresholds and calibration rule.
- No optimizer.

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Brokerage charged on options expiring worthless (r2) | Medium: overstated costs by ₹86 a trade | **Fixed** (r3; r2 kept for reproduction) |
| F2 | Engine did not detect missing trading days; a gap would silently skip signals or settlements | High: silent wrong results | **Fixed**: throws |
| F3 | An open position with no expiry-day data would stay open forever and drop out of results | High: silent loss omission | **Fixed**: throws |
| F4 | 2024 NSE holidays missing (needed for F2 on 2024 data) | Low | **Fixed** (circular FAOP59723 + special sessions) |
| F5 | Empirical VaR tail size used `ceil(5.000000000000004) = 6` (new code, caught by tests) | Low | **Fixed** |
| F6 | Contracts identified by expiry, but NSE relabels expiries mid-life | Medium for multi-week holds | **Fixed** (2026-10-04): normalizer v2 stores `FinInstrmId` (verified stable across a relabel); the engine follows held legs by id daily, follows a relabel when all legs agree, and throws if a held contract vanishes. Tested; reference results unchanged |
| F7 | A signal whose legs are untraded on the signal day returns no proposal, and is not recorded as skipped | Low (did not occur) | **Fixed**: strategies may return `{ noTrade: reason }`; the engine records it (`result.noTrade`). The reference run records none, confirming no expiry evening was dropped |
| F8 | Spec liquidity, spread and data-quality limits not enforced in the backtest | Low (never bound) | Open |
| F9 | Spread uncalibrated; the bhavcopy close is not a tradable price | High for any positive-gross strategy | Open: quote recorder running; rule pre-registered |
| F10 | Charges after 2026-04-01 and settlement charges not yet seen on a contract note | Medium | Open |
| F11 | Margin is a proxy | Medium | Open |
| F12 | A test claimed to cover the broker-disconnect lockout but did not | Low | **Fixed**: new test (preview and confirm both fail closed) |
| F13 | vitest dev dependency, moderate advisory | Low (dev only) | Accepted; upgrade to vitest 5 later |
| F14 | The download CLI skipped Muhurat special sessions (bhavcopy published on a holiday), so a clean checkout would get 493 of the 495 days and fail verification. Two reference trades were filled at Muhurat-session closes (entries 2024-11-01 and 2025-10-21) | Medium: reproducibility; fill realism | **Fixed.** Download: `SPECIAL_SESSIONS` / `expectBhavcopy`. Fills: owner decided to exclude special sessions; the engine default is now `NO_FILLS` (the order waits for the next regular close). Tested as pre-registered **EXP-0006 → EXP-0007: REJECTED**, net −₹61,313.06; exactly the 2 predicted trades changed. EXP-0001/0002 stay reproducible with `--special-sessions allow` |

## Paper, shadow and live policy (unchanged, restated)

- `TRADING_MODE` defaults to paper. `live` throws unconditionally; enabling it requires a reviewed
  code change against LIVE_TRADING_READINESS.md, never an environment variable.
- The only order path is ExecutionEngine → RiskGateway → BrokerAdapter, with a human confirmation code.
  The only BrokerAdapter is PaperBroker. No MCP tool can reach it.
- The RiskGateway locks out on: kill switch, market closed, broker disconnected, stale or degraded
  data, stale quotes, abnormal spread, duplicate orders, missing hedge or undefined max loss, and
  breached loss and cost limits. All are covered by tests.
- A strategy reaches paper only after SURVIVES. It reaches shadow only after consistent paper
  results, and a live pilot only after every readiness gate. **The reference strategy reaches none of these.**

## Security (summary)

See SECURITY_AUDIT.md, "Re-audit, Foundation phase":
- No secrets or PII anywhere in the git history.
- Personal broker files are ignored for every clone.
- The contract-note converter strips personal data and refuses to write inside the repository.
- 0 production vulnerabilities.
- No order endpoints, and no path to live execution.

## Reproduce

```bash
npm ci --ignore-scripts && npm run build && npm test
node dist/bhavcopy-cli.mjs --from 2024-07-08 --to 2026-10-01
npm run backtest:verify && npm run backtest:verify-original   # raw hash + every trade exact; normalized hash vs data-versions.json pin
python scripts/verify_reference.py --golden src/strategy/reference/golden/ref_iron_condor_v1.0.0_audited_r3_v1.json
python scripts/audit_bhavcopy.py
node dist/foundation-analysis-cli.mjs --special-sessions allow   # analyses as documented (EXP-0002)
npm run backtest:verify-exp0006                                  # current policy (EXP-0006/0007)
node dist/experiments-cli.mjs verify
```

## What would change these decisions

- **Foundation → PASS**:
  - ≥ 20 recorded sessions and a calibrated spread under the pre-registered rule
  - a reconciled contract note from after April 2026 that includes an expiry-day ITM settlement
  - broker-verified margin for one structure
- **Strategy**: nothing. v1.0.0 is rejected. A different strategy starts as a new registered
  experiment, and the answer may again be NO TRADE.
