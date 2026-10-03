# Paper Trading (Phases 7, 9, 10, 23)

Code: `src/broker/types.ts` (BrokerAdapter), `src/broker/paper-broker.ts`,
`src/broker/journal.ts`, `src/pnl/pnl-engine.ts`. Tests: `src/__tests__/paper-execution.test.ts`.

The paper broker is **not** reachable from the MCP server (verified: no broker or execution
code in `dist/bundle.mjs`). It is a library for the execution engine and future backtest /
shadow harnesses.

## What it simulates

| Feature | Behaviour |
|---|---|
| Fill price | MARKET buys at **ask**, sells at **bid** (never LTP), plus optional slippage model rounded to tick against the order. LIMIT fills at the touch only if it is at or better than the limit |
| Partial fills | Limited by displayed quantity at the touch, rounded down to whole lots |
| Delayed fills | Resting orders re-evaluated on every new quote |
| Stale quotes | No fill if quote age > 5 s (configurable); event journaled |
| Validation | lot-size multiple, tick-size multiple, positive prices, instrument known and not expired |
| Funds | buys need premium + estimated charges ≤ available funds |
| Margin | opening/increasing a short **requires** a margin model; without one the order is rejected (fail closed). Futures likewise |
| Idempotency | `clientOrderId` replay returns the original order; reuse with different parameters throws |
| Cancel / modify | open or partially filled orders only |
| Costs | every fill priced by the TransactionCostEngine; brokerage once per executed order |
| Expiry | cash-settled index options settle at intrinsic; long ITM pays exercise STT |
| Accounting | equity = cash + position marks; identity `netPnL = realized gross + unrealized gross − all charges` is tested |
| Daily / weekly P&L, drawdown | from equity at IST day / ISO-week start; peak-to-trough drawdown |
| Journal | append-only, SHA-256 hash-chained, redacted payloads, optional JSONL file; tampering is detected on reload |

## NET-only reporting

Each closed position cycle is passed to the PnLEngine with the actual simulated charges.
`classification` is `NET_PROFIT`, `NET_LOSS` or `NET_BREAKEVEN` from **net** P&L only, and
`grossProfitNetLoss` flags trades that made money gross but lost money net. Example (test):
buy 65 @ 101, sell @ 101.5 → gross +₹32.50, net negative → **NET LOSS**.

## Known limitations

- Depth-1 book only; no queue position; limit orders fill fully at the touch if displayed size allows.
- No exchange price bands, freeze quantities, or order-rate limits.
- Futures cash accounting reserves full notional (conservative, approximate).
- Margin is whatever model is injected — there is no SPAN implementation.
- Positions are marked at mid; with no two-sided quote, at LTP; with no quote, at average price.
- Not yet driven by recorded market data (that is the backtest/shadow work).
