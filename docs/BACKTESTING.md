# Backtesting (Phases 11, 12, 15, 16)

**Status: no backtest has been run. There is no historical option data source.** The NSE
provider only returns the current chain; computations on it are not backtests.

## What exists

| Piece | File | Status |
|---|---|---|
| `HistoricalMarketDataProvider` interface (point-in-time bid/ask/LTP/volume/OI/IV/expiry/lot size) | `src/backtest/historical-data.ts` | interface only |
| `PointInTimeGuard` — throws `LookAheadError` on any record time-stamped after the decision time and on settlement access before expiry | same | tested |
| NET metrics: expectancy ± SE, win rate, avg win/loss, profit factor, drawdown, losing streak, per-trade Sharpe/Sortino, costs vs gross | `src/analytics/performance.ts` | tested |
| Verdicts: `UNKNOWN` (< 100 trades or not significant), `NEGATIVE NET EXPECTANCY`, `PROFITABLE BEFORE COSTS BUT NOT VALIDATED AFTER COSTS`, `POSITIVE NET EXPECTANCY IN SAMPLE — NOT VALIDATED OUT-OF-SAMPLE` | same | tested |
| Cost sensitivity BASE / WORSE / SEVERE; break-even gross per trade, win rate, cost per trade, extra slippage | `src/analytics/cost-sensitivity.ts` | tested |

## Required before any backtest result is trusted

1. A licensed point-in-time options dataset (bid/ask, not just LTP; OI; lot sizes over time;
   expiry calendars over time; settlement prices). Candidates: broker historical APIs
   (limited for expired options), exchange data products, Dhan expired-options API — evaluate
   licensing and completeness.
2. Simulator that replays snapshots through the PaperBroker (same fill rules, same cost engine).
3. Charge schedules covering the full test period (currently only from 2024-10-01).
4. Regime coverage: normal, high-volatility, gap days, expiry days, low liquidity, fast moves,
   large drawdowns; pre/post 2025-09 expiry-day change; lot-size changes.
5. Walk-forward with out-of-sample periods fixed **before** looking at results; parameter
   perturbation; Monte Carlo resampling of trade sequences; losing-streak stress; the three
   cost scenarios. A strategy is not promoted on in-sample profit.
