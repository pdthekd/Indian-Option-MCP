# Shadow Trading (Phase 20)

**Status: NOT IMPLEMENTED.** `TRADING_MODE=shadow` is recognised and refuses execution.

## Design (to implement)

Run the strategy on live market data; for every signal, build the same `OrderPreview` the
execution engine would, but never call a broker. Record to the hash-chained journal:

timestamp · market snapshot reference and data-quality status · strategy ID, version and
fingerprint · proposed instruments, quantities and prices · expected fills (bid/ask + slippage)
· risk-gateway decision with every check · reason for signal or rejection · subsequent market
prices at exit times defined by the spec · gross simulated P&L · all simulated costs · NET
simulated P&L · estimated tax impact (annual layer).

Reports must show **GROSS P&L, COSTS, NET P&L** side by side and use the verdicts in
BACKTESTING.md. A positive result is reported only if NET P&L is positive and statistically
distinguishable from zero over a pre-registered sample size.
