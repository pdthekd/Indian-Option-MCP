# Live Trading Readiness — Go / No-Go (Phase 27)

Assessed 2026-10-03 on branch `audit/foundation`.

## Decision: **NO-GO.** Live trading is not permitted.

There are multiple unresolved critical blockers. `TRADING_MODE=live` is hard-disabled in code.

## Gate table

| AREA | STATUS | EVIDENCE | BLOCKER? |
|---|---|---|---|
| Security | PASS WITH CONDITIONS | SECURITY_AUDIT.md: no secrets, no dangerous APIs, fixed host allowlist, bounded schemas, redaction, fail-closed provider. Conditions: Actions not SHA-pinned (release workflow now disabled) | No (for paper) |
| Dependencies | PASS WITH CONDITIONS | `npm audit --omit=dev`: 0 vulnerabilities. Dev: 2 moderate (vitest mocker, needs major upgrade, not reachable) | No |
| Secrets | PASS | Full-history scan clean; KITE_API_SECRET no longer read; journal/log redaction tested | No |
| MCP | PASS WITH CONDITIONS | MCP_TEST_REPORT.md: 20/20 stdio checks (19 offline + 1 live), 9 integration tests, stdout clean. Conditions: not tested in Claude Desktop or during market hours | No |
| Data quality | PASS WITH CONDITIONS | FULL/DEGRADED/STALE/UNAVAILABLE states; no zero-substitution; single-expiry chains; tested. Conditions: NSE source is unofficial and fails off-hours; no licensed feed | **Yes** (for live) |
| Calculations | PASS WITH CONDITIONS | Reference/property tests for BS, Greeks, IV, payoff, POP, sizing. Fixed F1, F4–F8, F11, F14–F16 + deep-ITM IV bound. Open: margin heuristic (F3), stock lot sizes and non-NIFTY index revisions unverified (F10), 2025 holiday list unverified (F18; 2026 is official) | **Yes** |
| Tests | PASS | 142 unit/integration tests passing under IST, UTC, New York and UTC+14; tsc clean; build reproducible with pinned esbuild | No |
| Transaction-cost engine | PASS WITH CONDITIONS | Versioned schedules, fail-closed lookup, tested hand calculations. Several rates **UNVERIFIED** against primary sources (TRANSACTION_COST_MODEL.md) | **Yes** (until independently validated) |
| Tax model | PASS WITH CONDITIONS | Separate annual estimate layer, labelled; rules UNVERIFIED; set-off not modelled | No (estimate only) |
| Paper trading | PASS WITH CONDITIONS | PaperBroker with bid/ask fills, partials, costs, journal, NET classification — unit-tested only; never run on recorded market data | **Yes** |
| Sandbox | NOT TESTED | No sandbox adapter; BROKER_EVALUATION.md shows neither Kite nor Upstox sandbox covers options end-to-end | **Yes** |
| Backtesting | NOT TESTED | No historical option data source; interface + look-ahead guard only | **Yes** |
| Out-of-sample | NOT TESTED | No backtests exist | **Yes** |
| Shadow trading | NOT TESTED | Not implemented | **Yes** |
| Broker integration | FAIL | Only a read-only Kite data provider with known defects (F17); no order adapter; no margin API | **Yes** |
| Risk controls | PASS WITH CONDITIONS | Deterministic gateway with all Phase 13 lockouts, hedge check, NET loss limits; tested. No real margin source; no automated exit monitoring | **Yes** |
| Reconciliation | PASS WITH CONDITIONS | Expected vs actual qty/price/charges per leg, journaled, never overwritten; tested against PaperBroker only — no broker contract notes | **Yes** |
| Observability | FAIL | Journal exists; no dashboards/reports for gross/costs/net/tax/drawdown/errors (Phase 24) | **Yes** |
| Kill switch | PASS WITH CONDITIONS | Latching, human-only reset, auto-engaged on failed leg; tested. Not wired to any external broker kill switch | No (for paper) |

## Strategy profitability

**UNKNOWN.** No strategy has been backtested, paper-traded on market data, or shadow-traded.
Nothing in this repository is evidence of positive NET expectancy.

## Minimum path to reconsider (in order)

1. Licensed point-in-time option data → backtest harness through PaperBroker → walk-forward
   and out-of-sample with BASE/WORSE/SEVERE costs (BACKTESTING.md).
2. Independently verify every charge and tax parameter; promote to `OFFICIAL` schedules.
3. Replace margin heuristic with broker margin API; replace static lot sizes with instrument master.
4. Shadow trading on live data for a pre-registered sample size; NET results only.
5. Sandbox adapter for API mechanics; reconciliation against contract notes.
6. Observability reports (Phase 24).
7. Only then a separate, reviewed code change for a live adapter with the Phase 21 controls
   (explicit flag + human confirmation + tiny capital + strict max loss/orders/lots/costs +
   kill switch + reconciliation + independent logging + automatic shutdown).
