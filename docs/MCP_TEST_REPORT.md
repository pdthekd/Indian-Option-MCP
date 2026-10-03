# MCP Test Report (Phase 4)

Date: 2026-10-03 (Saturday — market closed). Branch `audit/foundation`.

## Method

The official MCP Inspector is normally launched with `npx @modelcontextprotocol/inspector`,
which downloads and runs an unpinned package. That conflicts with the supply-chain rules in
SECURITY_AUDIT.md, so it was **not** used. Two equivalent harnesses were used instead,
both built only on the lockfile-pinned `@modelcontextprotocol/sdk@1.29.0`:

1. **`scripts/mcp-smoke.mjs`** (`npm run test:mcp`): spawns the *built* `dist/bundle.mjs`
   over real stdio with a minimal environment, speaks raw JSON-RPC, and inspects every
   stdout line.
2. **`src/__tests__/server.test.ts`**: in-memory transport with a fake provider
   (hermetic, deterministic clock) — runs in `npm test`.

To use the graphical Inspector safely: add it as a pinned devDependency, review it, and run
it from `node_modules/.bin`.

## Results — stdio harness (`node scripts/mcp-smoke.mjs --live`)

| Check | Result |
|---|---|
| `initialize` handshake | PASS |
| 29 tools registered (27 original + `estimate_transaction_costs`, `estimate_tax`) | PASS |
| No order/execution tool exposed | PASS |
| Every tool has an object input schema | PASS |
| Resource `market://status` registered; 2 prompts | PASS |
| Schema rejects: negative spot, bad enum, 1,000-char symbol, injection-style expiry, 50-leg array, zero max loss | PASS (6/6) |
| Pure tools deterministic (identical output on repeat) | PASS |
| Cost tool: 0.15 % STT on ₹6,500 sell premium = ₹9.75 | PASS |
| **Live NSE** read (one call) | PASS — see below |
| stdout contains only JSON-RPC (0 stray lines) | PASS |
| stderr contains no credential material | PASS |
| `DATA_PROVIDER=zerodha` without credentials → exits 1 (fail closed) | PASS |
| Invalid `DATA_PROVIDER` → exits non-zero | PASS |

### Live call observation (important)

On a Saturday the primary NSE endpoint failed and the provider used the fallback. The tool
returned:

```
DATA QUALITY: STALE (source: nse-fallback) | age 181811s | unavailable: impliedVolatility, bidPrice, askPrice, bidQty, askQty, changeinOpenInterest
  - Fallback endpoint ... lists only the most-active contracts — the chain is INCOMPLETE ...
  - Market is not open; values are the last published snapshot.
```

At baseline the same data would have been shown with `IV 0.0`, `bid 0`, `ask 0`, `Chg OI +0`,
and timestamp presented as current — indistinguishable from real values.

## Results — in-memory integration tests (`npm test`)

9 tests: registration, malformed-input rejection (8 cases), deterministic chain output with
quality banner and data age, GROSS/costs/NET in `build_strategy`, refusal to price a leg with
no market price, naked short call reported as **unlimited** loss, unlisted expiry rejected,
calendar strategies refused, tax output labelled as estimate.

## Network failures and timeouts

- NSE: 15 s per-request timeout (AbortController), 3 attempts with back-off; failures surface
  as tool errors containing both primary and fallback reasons. Verified via the live run above
  (primary failure → fallback) and unit tests on the mapping. Worst-case latency can exceed
  60 s because requests are serialised — **open issue**.
- Zerodha: 30 s timeout, no retry. Not exercised (no credentials should be used).
- Stale data is labelled `STALE` (market closed, unknown age, or age > 120 s while open).

## Not tested

- Behaviour under Claude Desktop specifically (only generic stdio clients).
- Zerodha provider against a real or sandbox Kite account.
- Concurrency under many simultaneous tool calls.
- NSE responses during market hours (audit run on a non-trading day).
