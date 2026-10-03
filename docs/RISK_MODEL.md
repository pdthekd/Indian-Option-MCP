# Risk Model (Phases 13, 21, 22, 25)

Code: `src/risk/risk-gateway.ts`, `src/risk/kill-switch.ts`, `src/trading/mode.ts`,
`src/execution/execution-engine.ts`.

## Order path (the only one)

```
Strategy proposal (Claude may draft; it cannot submit)
  → data-quality status check
  → expected fills at bid/ask (+ slippage model)
  → TransactionCostEngine (entry + exit) and exit spread
  → exact expiry payoff → NET worst-case loss
  → RiskGateway.evaluateRisk (pure, deterministic, all checks reported)
  → OrderPreview with confirmation code (only if approved; expires in 60 s)
  → HUMAN types code + operator name
  → re-validation at current quotes (risk + price drift)
  → hedge (BUY) legs first, then SELL legs, via BrokerAdapter.placeOrder
  → any non-filled leg: cancel remaining + engage kill switch
  → reconciliation expected vs actual → journal
```

`ExecutionEngine` refuses to construct unless `TRADING_MODE` resolves to `paper` and the
broker is a paper broker. `TRADING_MODE=live` throws. Nothing in the MCP server can change
the mode.

## Checks (all evaluated every time)

kill switch · trading enabled · market open · broker connected · data quality ≥ minimum ·
defined (finite) max loss · max NET risk per trade · max transaction costs per trade ·
hedge present for every short option (aggregate long ≥ short per underlying/expiry/type) ·
daily NET loss (incl. this trade's worst case) · weekly NET loss · drawdown · open positions ·
concurrent strategies · orders per day · margin known for shorts · margin utilisation ·
lots per order · notional · quote freshness (stale-data lockout) · two-sided quote and spread
(abnormal-spread lockout) · limit vs mid (price-tolerance lockout) · expected slippage
(excessive-slippage lockout) · duplicate (same symbol/side/qty within window).

## Default limits (`CONSERVATIVE_DEFAULT_LIMITS`)

| Limit | Value |
|---|---|
| Max NET risk / trade | ₹2,000 |
| Max daily / weekly NET loss | ₹3,000 / ₹6,000 |
| Max drawdown | 10 % |
| Max open positions / strategies | 4 / 1 |
| Max lots per order | 1 |
| Max orders / day | 10 |
| Quote age / spread / price deviation / slippage | 5 s / 5 % / 3 % / 2 % |
| Max costs / trade | ₹300 |
| Min data quality | FULL |
| Defined risk required | yes |

These are placeholders for paper testing, not recommendations.

## Behavioural safeguards

- No inputs for recent wins/losses, targets, monthly income or model confidence exist in
  the gateway, so it cannot "trade more to make it back".
- Kill switch latches; only a human with the exact phrase can reset it (journaled).
- Separation of money concepts (Phase 25) — to be enforced in reporting: TRADING_CAPITAL,
  REALIZED_NET_PROFIT, UNREALIZED_NET_P&L, TRADING_COSTS, ESTIMATED_TAX, WITHDRAWABLE_PROFIT.
  No withdrawal policy exists and none may feed trade selection.

## Gaps

- No real margin source (broker basket-margin API) — shorts require an injected model.
- Monthly drawdown is approximated by peak-to-trough drawdown.
- No intraday position-level stop monitoring loop yet (exit rules are not automated).
