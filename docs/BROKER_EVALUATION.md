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

## Assessment for this system

1. **Testing path:** Upstox's sandbox is the only one documented to support F&O order
   placement explicitly; but it covers only place/modify/cancel — no positions, funds or
   trades yet — so it cannot validate reconciliation. Kite's sandbox has richer order
   lifecycle and portfolio APIs but documents only NSE equity LIMIT orders. **Neither sandbox
   is sufficient to validate an options strategy end-to-end.** The in-repo PaperBroker remains
   the primary test harness; a sandbox adapter would test only API mechanics (auth, payloads,
   error codes, idempotency, cancel races).
2. **Data for backtesting:** Dhan's expired-options API is the most promising lead for
   point-in-time option history; licensing, bid/ask availability and completeness must be
   checked.
3. **Existing integration:** the codebase already has a read-only Kite data provider
   (with defects listed in FUNCTIONAL_AUDIT F17). Kite Connect (₹500/mo) gives WebSocket and
   historical candles needed for shadow trading.
4. **Recommendation (engineering, not financial):** build `ZerodhaSandboxBroker` *only* to
   exercise API mechanics, with `KITE_ENV=sandbox` as the default and a hard check that the
   sandbox host is used with the demo key and the production host is never used with it.
   Evaluate Upstox sandbox for F&O payload validation. Defer any live adapter (Phase 21).

## Not done

- Detailed review of each broker's full API reference (only overview pages were read).
- Verification of rate limits, token lifetimes and kill-switch APIs for Upstox, Dhan,
  Angel One and FYERS.
- Legal review of NSE website scraping vs. licensed data.

Note: this workstation also has an Angel One trading connector configured in the assistant
environment. It was not used and must not be wired into this system: it bypasses the risk
gateway and human-confirmation flow.

## Sources

- https://kite.trade/docs/connect/v3/sandbox/ [O]
- https://zerodha.com/products/api/ [O], https://zerodha.com/charges [O]
- https://upstox.com/developer/api-documentation/sandbox/ [O]
- https://dhanhq.co/docs/v2/ [O]
- https://www.angelone.in/knowledge-center/smartapi/detailed-introduction-to-smartapi [S]
- https://fyers.in/products/api [S]
- SEBI algo framework summaries: https://hdfcsky.com/sky-learn/algo-trading/sebi-algo-trading-rules [S]
