# Transaction Cost Model (Phase 6)

Code: `src/costs/transaction-cost-engine.ts` (engine), `src/config/charges/nse-fo.ts`
(statutory/exchange schedules), `src/config/charges/brokerage.ts` (broker plans).
Tests: `src/__tests__/costs-pnl-tax.test.ts`.

The engine is the **only** place costs are computed. It is independent of strategy logic and
is used by MCP tools, the PnL engine, the paper broker and the execution engine.

## Components (NSE F&O)

| Component | Options | Futures | Base | Side |
|---|---|---|---|---|
| Brokerage (plan) | flat ₹20 / executed order | min(0.03 % × turnover, ₹20) / executed order | per order | both |
| STT | 0.15 % of premium (from 2026-04-01; 0.10 % before) | 0.05 % (from 2026-04-01; 0.02 % before) | turnover | **sell** |
| STT on exercise | 0.15 % of intrinsic value (0.125 % before) | — | (settle − strike) × qty | holder |
| Exchange transaction | 0.03503 % of premium | 0.00173 % | turnover | both |
| IPFT | ₹50 / crore (0.0005 %) | ₹10 / crore (0.0001 %) | turnover | both |
| SEBI fee | ₹10 / crore | ₹10 / crore | turnover | both |
| Stamp duty | 0.003 % | 0.002 % | turnover | **buy** |
| GST | 18 % of (brokerage + exchange + IPFT + SEBI) | same | — | both |
| Slippage | reported separately (execution shortfall vs reference price) | same | ₹ | both |

Turnover for options = **premium** × quantity (not notional).

## Versioning

Schedules have `effectiveFrom` / `effectiveTo` (IST trade dates). `scheduleFor(date)`:
- returns exactly one schedule, or **throws** (no schedule / overlap) — fail closed;
- schedules are never edited in place: close the old one and add a new one;
- every schedule lists its sources with a verification level.

| Schedule | Effective | Key change |
|---|---|---|
| `IN-NSE-FO-2024-10-01` | 2024-10-01 → 2026-03-31 | STT 0.10 % options / 0.02 % futures |
| `IN-NSE-FO-2026-04-01` | 2026-04-01 → open | STT 0.15 % options & exercise / 0.05 % futures (Budget 2026) |

## Verification status — read before relying on numbers

| Item | Source | Level |
|---|---|---|
| Current STT, exchange (combined), SEBI, stamp, GST base, brokerage | zerodha.com/charges, fetched 2026-10-03 | BROKER_PUBLISHED |
| Budget 2026 STT change and 2026-04-01 effective date | secondary reporting (ICICI Direct, ClearTax) | UNVERIFIED |
| Split of broker-published 0.03553 % into exchange 0.03503 % + IPFT 0.0005 % | inference (total matches) | UNVERIFIED |
| Exchange charges before 2026-04-01 | assumed unchanged | UNVERIFIED |
| Exercise: no exchange/SEBI/stamp charges; ₹0 brokerage | assumption | UNVERIFIED |

**Before any live use:** verify each item against the Finance Act 2026, NSE circulars and the
broker's contract notes, then promote the level to `OFFICIAL` in a new schedule version.

## Rounding

Each component is rounded to the paisa per order. Contract notes may round differently
(e.g. STT at contract-note level). Differences are expected to be < ₹1 per note and must be
captured by reconciliation (actual charges replace modelled ones in the PnL engine).

## Known limitations

- BSE (SENSEX/BANKEX) schedules not modelled — engine throws for non-NSE.
- Physically-settled stock option exercise/assignment not modelled — throws.
- Futures partial fills: brokerage charged on the first fill only (approximation).
- DP charges, call-and-trade fees, auto-square-off charges, interest on margin shortfall,
  and broker-specific extras are not modelled.
- Market impact is not modelled beyond the slippage models (TICKS, BPS, SPREAD_FRACTION).

## Example (from tests)

BUY 75 @ ₹100 on 2026-10-05: turnover ₹7,500; brokerage ₹20; STT ₹0; exchange ₹2.63; IPFT ₹0.04;
SEBI ₹0.01; stamp ₹0.23; GST ₹4.08; **total ₹26.99**.
