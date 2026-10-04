# Broker Evaluation (Phases 17–19)

Researched 2026-10-03. Each fact is tagged: **[O]** read on the broker's official site/docs
that day; **[S]** secondary source (blogs, aggregators) — verify before relying on it;
**[?]** not found. Brokerage cost was deliberately **not** a primary criterion.

## Regulatory context [S]

SEBI's retail algo framework (circular Feb 2025) is mandatory for brokers from 2026-04-01:
client-specific API keys, **static IP whitelisting for order APIs**, OAuth + 2FA, API sessions
closed daily, and registration of algos above **10 orders/second per exchange**. This system's
design (human-confirmed, ≤ 10 orders/day) stays far below the OPS threshold, but a static IP
is needed for any order API use.

## Summary matrix

| Criterion | Zerodha Kite Connect | Upstox | Dhan | Angel One SmartAPI | FYERS |
|---|---|---|---|---|---|
| Official API | yes [O] | yes [O] | yes [O] | yes [O] | yes [S] |
| Cost | Personal: free (orders, GTT, margins); Connect: ₹500/mo for WebSocket + historical [O] | [?] | [?] | free incl. data [S] | free [S] |
| Sandbox | **yes**: `sandbox.kite.trade`, demo creds, `/oms` prefix, LIMIT only, NSE equity examples; F&O **not mentioned** [O] | **yes**: place/modify/cancel (+ multi-order) only; 30-day sandbox token; positions/funds/market data "phased" [O] | "sandbox" developer kit link [O], scope [?] | [?] | [?] |
| Options orders (prod) | yes (NFO) | yes (`NSE_FO|…`) [O] | yes | yes incl. BFO [S] | yes |
| Option chain API | no (build from instruments + quotes) | [?] | yes [O] | [?] | yes (OI, LTP, bid/ask) [S] |
| Historical options | candles for live contracts (Connect plan); expired limited [S] | [?] | **Expired Options Data API** [O] | derivatives candles incl. OI [S] | yes [S] |
| WebSocket | yes (Connect plan) [O] | yes [S] | yes [O] | yes [S] | yes [S] |
| Multi-leg / basket | basket margin calc; no atomic multi-leg [S] | Place Multi Order (sandbox-enabled) [O] | super/forever orders [O] | GTT [S] | [?] |
| Rate limits | quote 1/s, orders ~10/s (per Kite docs, [S]) | [?] | orders 10/s, 7,000/day; quotes 1/s [O] | [?] | [?] |
| Static IP | required for orders under SEBI rules [S] | same | same | supported/validated [S] | orders only [S] |
| Token lifetime | daily session [S] | sandbox token 30 days [O] | [?] | JWT + TOTP [S] | [?] |
| Sandbox isolated from live credentials | separate demo key `sandboxdemo` [O] | "sandbox tokens cannot be used for live" [O] | [?] | n/a | n/a |
| Kill-switch API | [?] | [?] | [?] (Dhan advertises a kill switch in-app [S]) | [?] | [?] |

## Evaluation framework (Foundation phase, 2026-10-04)

**No broker is selected or recommended.** A broker decision is premature while no strategy has
reached SURVIVES (EXPERIMENT_PROTOCOL.md §2); the only tested strategy is REJECTED. This section
fixes **how** a broker will be chosen when that changes, so the choice is not driven by convenience
or by whichever API is already wired in.

### Hard gates (any failure excludes the broker)

| # | Gate | Evidence required |
|---|---|---|
| G1 | Official, documented order API for NSE index options | [O] API reference |
| G2 | A non-production environment, or a documented way to test order payloads without real orders | [O] docs + a successful test call |
| G3 | Sandbox/test credentials cannot reach production, and production credentials cannot be used in the sandbox | [O] docs + a negative test (expected rejection) |
| G4 | Order status, positions, trades and funds available by API (needed for reconciliation) | [O] API reference + calls on a real account, read-only |
| G5 | SEBI retail-algo compliance path (static IP, per-client key, daily session) workable for a single user | [O] broker notice |
| G6 | Contract notes downloadable in a machine-readable form (for cost reconciliation) | sample note |
| G7 | Credentials can be kept out of source control, logs and prompts (env/OS store; no long-lived tokens in files) | design review |

### Scored criteria (only among brokers passing every gate)

| Criterion | Weight | How measured |
|---|---:|---|
| Order lifecycle fidelity (ack, partial fill, reject, cancel race, idempotency key) | 25 | sandbox tests in a `BrokerAdapter` conformance suite |
| Reconciliation completeness (orders ↔ trades ↔ positions ↔ funds ↔ contract note) | 20 | end-to-end on paper-sized real activity or sandbox |
| Market data quality (two-sided quotes, depth, timestamps, OI) | 15 | compare with recorded NSE data |
| Operational safety (kill switch / order-disable API, session expiry behaviour, rate limits) | 15 | docs + tests |
| Total cost (API subscription + brokerage + exit/settlement charges) | 10 | reconciled contract notes, not the price list |
| Reliability (documented outages, status page, support response) | 10 | 8 weeks of shadow-mode logs |
| Historical option data access | 5 | point-in-time completeness check |

Brokerage price is deliberately a minor weight: at 1-lot size the strategy's gross result dominates,
and cost differences are measurable only through reconciled notes.

### Procedure

1. Re-verify the matrix above from official pages (many cells are [S] or [?]).
2. Apply the gates. Record each result with its evidence link and date.
3. Build a sandbox adapter only for gate-passing candidates: mechanics only (auth, payloads, error
   codes, cancel races), with the sandbox host as default and a hard check that the production host
   is never used with sandbox credentials.
4. Run the same `BrokerAdapter` conformance suite against PaperBroker and each sandbox adapter.
5. Score; write the decision and its evidence to this document. Live order capability stays disabled
   (`TRADING_MODE=live` throws) until LIVE_TRADING_READINESS.md is fully met.

### Facts already established (not a recommendation)

- Upstox documents F&O order placement in its sandbox, but only place/modify/cancel; no positions,
  funds or trades, so it cannot exercise reconciliation (G4 untested in sandbox).
- Kite's sandbox documents NSE equity LIMIT orders; F&O is not mentioned. The codebase already has a
  read-only Kite **market-data** provider, which is a convenience, not a selection criterion.
- Dhan documents an expired-options data API: a lead for historical data, not for execution.
- The cost model is reconciled only against Zerodha contract notes, because those are the notes
  available. This must not bias the selection: other brokers' costs need their own reconciled notes.

## Not done

- Detailed review of each broker's full API reference (only overview pages were read).
- Verification of rate limits, token lifetimes and kill-switch APIs for Upstox, Dhan,
  Angel One and FYERS.
- Legal review of NSE website scraping vs. licensed data.

Note: this workstation also has Angel One, IBKR and INDmoney connectors configured in the assistant
environment. They were not used and must not be wired into this system: they bypass the risk
gateway and human-confirmation flow.

## Sources

- https://kite.trade/docs/connect/v3/sandbox/ [O]
- https://zerodha.com/products/api/ [O], https://zerodha.com/charges [O]
- https://upstox.com/developer/api-documentation/sandbox/ [O]
- https://dhanhq.co/docs/v2/ [O]
- https://www.angelone.in/knowledge-center/smartapi/detailed-introduction-to-smartapi [S]
- https://fyers.in/products/api [S]
- SEBI algo framework summaries: https://hdfcsky.com/sky-learn/algo-trading/sebi-algo-trading-rules [S]
