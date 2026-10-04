# Tail Loss Analysis (Foundation Phase 8)

Date: 2026-10-04. Subject: `ref_nifty_weekly_iron_condor` v1.0.0, audited run (EXP-0002: brokerage
plan r3, spread EOD_PESSIMISTIC_V1), 2024-10-01 → 2026-10-01, 104 trades, 1 lot.
All figures are **NET** of modelled charges and spread. Reproduce with
`node dist/foundation-analysis-cli.mjs` (module `src/analytics/tail-loss.ts`).

## Summary

This strategy's results are set by its tails. It wins often and small, and loses rarely and large:
**the ten worst trades account for 67 % of all losses**, and one average loss erases about four
average wins. The structure is defined-risk, and no trade lost more than its theoretical maximum.
But that maximum was reached, and the sample of tail events is small.

## Distribution

| Metric | Value |
|---|---:|
| Trades / net wins | 104 / 77 (74.0 %) |
| Sum of net wins | ₹1,28,659.65 |
| Sum of net losses | −₹1,89,667.88 |
| Average net win / loss | ₹1,670.90 / −₹7,024.74 |
| Average wins needed to repay the worst loss | 10.7 |
| Worst 5 trades' share of all losses | 40.0 % |
| Worst 10 trades' share of all losses | 67.0 % |
| Max consecutive losing trades | 8 |
| Max net drawdown (closed trades) | ₹70,366.02 |

Empirical per-trade loss quantiles (sample-based; the 99 % figures rest on 1–2 trades):

| | VaR | Expected shortfall |
|---|---:|---:|
| 95 % | ₹13,395.61 | ₹14,996.14 |
| 99 % | ₹15,485.56 | ₹16,646.41 |

## Outcome at expiry

| Outcome | Trades | Net |
|---|---:|---:|
| All four legs expire OTM (max profit) | 74 | +₹1,24,927.70 |
| A short strike finishes ITM, wing does not | 24 | −₹1,13,415.19 |
| Wing fully breached (maximum loss) | 6 | −₹72,520.74 |

Thirty trades (29 %) ended with a short strike in the money, and their losses outweigh all 74
full-profit trades.

## Worst trades

| Trade (expiry) | Net | Outcome |
|---|---:|---|
| NIFTY-2025-03-20 | −₹17,807.26 | WING_FULLY_BREACHED |
| NIFTY-2025-04-09 | −₹15,485.56 | WING_FULLY_BREACHED |
| NIFTY-2025-05-15 | −₹15,307.37 | WING_FULLY_BREACHED |
| NIFTY-2025-06-26 | −₹14,499.17 | SHORT_BREACHED |
| NIFTY-2025-10-20 | −₹13,481.86 | SHORT_BREACHED |
| NIFTY-2026-06-16 | −₹13,395.61 | SHORT_BREACHED |
| NIFTY-2025-01-09 | −₹10,467.12 | SHORT_BREACHED |
| NIFTY-2025-04-17 | −₹10,059.21 | WING_FULLY_BREACHED |
| NIFTY-2026-04-07 | −₹8,746.26 | WING_FULLY_BREACHED |
| NIFTY-2026-04-21 | −₹8,554.98 | SHORT_BREACHED |

The raw-data audit records NIFTY close-to-close moves of −3.24 % (2025-04-07) and +3.82 %
(2025-05-12) inside the holding periods of the second and third worst trades.

Illustration only (removing trades after the fact is not a strategy): net without the worst
1 / 5 / 10 trades would be −₹43,200.97 / +₹15,572.99 / +₹66,796.17. The point is how much the
result depends on a handful of weeks, not that those weeks could have been avoided.

## Defined-risk check

- Theoretical max net loss per trade (widest wing × quantity − credit + costs) ranged from
  ₹3,424.98 (25-unit lots) to ₹22,433.93 (75-unit lots).
- Worst realized loss ÷ theoretical max: **100 %** for the worst trade, and **no trade exceeded
  100 %**. The hedge worked as designed, but the design allows a loss of about 8× the average credit
  (average credit at fill ₹2,278).
- The spec's limit `maxNetLossPerTradeRupees: 25,000` was never approached. It is not enforced by
  the backtest engine; the RiskGateway enforces risk limits for paper orders.

## Losses before expiry (end-of-day mark-to-market)

Each open position was marked at the bhavcopy close of every trading day between entry and
expiry, net of entry charges and spread paid.

| Metric | Value |
|---|---:|
| Worst end-of-day open P&L | −₹17,807.26 |
| Trades whose open P&L went below −₹5,000 on some day | 19 |
| … of which still finished as a net win | 1 |
| Mark days skipped for a missing close | 0 |

A trade that got into trouble rarely recovered. A stop-loss rule might look attractive here; any such
rule is a **new strategy** and must go through EXPERIMENT_PROTOCOL.md, not be added to v1.0.0.
EOD marks use closes, not intraday extremes, so true intraday drawdowns were larger, and the
weighted-average close is not a tradable price.

## Caveats

- **Lot size changed during the sample**: 25 units (contracts entered up to Jan 2025, by series), 75, then 65 (from the Jan 2026
  series). Rupee figures from different periods are not like-for-like; per-trade risk roughly tripled
  after the change to 75.
- 104 trades include only 6 maximum-loss events. Tail frequency is poorly estimated; a market with
  more gap days would produce more.
- Gap risk across weekends and holidays is in the data (EOD), but intraday paths and margin calls
  are not.
- Assignment / exercise on expiry is modelled as cash settlement at the exchange settlement price
  (correct for NIFTY index options). Physical settlement risk does not apply.
