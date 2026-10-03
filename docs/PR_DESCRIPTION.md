## Summary

Security and functional audit plus foundations for judging Indian F&O strategies on **NET P&L after all costs**. Analytics only. Live trading is hard-disabled; the readiness gate is **NO-GO** ([docs/LIVE_TRADING_READINESS.md](docs/LIVE_TRADING_READINESS.md)).

### Critical defects fixed (regression-tested)
- Payoff: a naked short call was reported with a **finite** max loss (−₹2,55,000); it is now **unlimited**. A short put is now correctly bounded.
- NSE chain merged **all expiries** when none was given, which corrupted max pain, PCR, OI and strategy premiums.
- Missing IV, bid, ask and change-in-OI were shown as `0`. They are now `null`/`n/a`, with a `FULL / DEGRADED / STALE / UNAVAILABLE` banner on every chain.
- The `utils/math` normal CDF was wrong (Φ(1) = 0.870), which skewed POP. POP is now computed from the actual payoff, net of costs.
- Position sizing double-counted lot size (it returned 0 lots).
- Time to expiry depended on the host time zone. The expiry calendar used the pre-Sept-2025 Thursday rules.
- The IV lower bound rejected valid deep in-the-money European puts.

### New
- `TransactionCostEngine` with date-versioned NSE charge schedules (STT 0.15% options / 0.05% futures from 2026-04-01). Fails closed when no schedule covers a date.
- One authoritative `PnLEngine` (gross, costs, net; NET_PROFIT / NET_LOSS classification).
- Separate annual `TaxModel`, labelled as an estimate.
- `PaperBroker`: bid/ask fills, partial and delayed fills, idempotency, full costs, hash-chained journal.
- `RiskGateway` with all Phase 13 lockouts, a latching `KillSwitch`, and a `TRADING_MODE` gate (`live` throws).
- `ExecutionEngine`: preview → human confirmation code → hedge legs first → reconciliation. Not reachable from the MCP server.
- Net performance metrics, cost-sensitivity scenarios, versioned strategy specs, a look-ahead guard for backtests.
- MCP tools `estimate_transaction_costs` and `estimate_tax`. Every strategy output now shows GROSS, costs and NET.

### Security / supply chain
- esbuild pinned as a devDependency and run locally (no `npx -y`). README no longer recommends `npx -y indian-option-mcp`.
- `npm audit fix`: runtime dependencies show 0 vulnerabilities (2 moderate remain in dev-only vitest; the fix needs a major upgrade).
- Bounded input schemas, credential redaction, `KITE_API_SECRET` no longer read, fail-closed provider selection.
- CI: `permissions: contents: read`, `npm ci --ignore-scripts`, runtime audit step, stdio smoke test.

### Not addressed (see docs)
- Margin estimate is still a heuristic (labelled unsafe). Lot sizes and the holiday list are unverified.
- Several charge rates and all tax parameters are not yet verified against primary sources.
- No historical data or backtests; no shadow trading; no sandbox or live broker adapter; no dashboards.
- `release.yml`: tag-name command-injection risk and npm publishing still need an owner decision.

## Test plan
- [x] `npm run lint` — clean
- [x] `npm test` — 142/142 passing (was 18). Also run under TZ=UTC, America/New_York and Pacific/Kiritimati.
- [x] `npm run build` — pinned local esbuild
- [x] `npm run test:mcp` — stdio smoke test, 19/19 offline checks (plus one live NSE check, also passing)
- [ ] CI on GitHub Actions (Node 20 & 22)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
