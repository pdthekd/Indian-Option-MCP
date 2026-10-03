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
| Exchange transaction | 0.03553 % of premium | 0.00183 % | turnover | both |
| IPFT | not listed for options | ₹0.01 / crore | turnover | both |
| SEBI fee | ₹10 / crore | ₹10 / crore | turnover | both |
| Stamp duty | 0.003 % | 0.002 % | turnover | **buy** |
| GST | 18 % of (brokerage + exchange + IPFT + SEBI + dealer fee) | same | — | both |
| Expiry settlement brokerage | ₹20 per settled contract: exercised, assigned **and** expired OTM | — | per position | holder / writer |
| Dealer / auto square-off fee | ₹50 per order + GST (opt-in flag `dealerPlaced`) | same | per order | both |
| Physical delivery (stock F&O) | 0.25 % of contract value — **not modelled; engine refuses** | same | contract value | both |
| Slippage | reported separately (execution shortfall vs reference price) | same | ₹ | both |

Turnover for options = **premium** × quantity (not notional).

## Versioning

Schedules have `effectiveFrom` / `effectiveTo` (IST trade dates). `scheduleFor(date)`:
- returns exactly one schedule, or **throws** (no schedule / overlap) — fail closed;
- schedules are never edited in place: close the old one and add a new one;
- every schedule lists its sources with a verification level.

| Schedule | Effective | Key change |
|---|---|---|
| `IN-NSE-FO-2024-10-01-r2` | 2024-10-01 → 2026-03-31 | STT 0.10 % options / 0.02 % futures |
| `IN-NSE-FO-2026-04-01-r2` | 2026-04-01 → open | STT 0.15 % options & exercise / 0.05 % futures (Budget 2026) |

Brokerage plan: `ZERODHA-FO-r2`.

### Corrections log

| Date | Superseded | Replaced by | Reason |
|---|---|---|---|
| 2026-10-03 | `IN-NSE-FO-2024-10-01`, `IN-NSE-FO-2026-04-01` | `…-r2` | The published transaction charge was wrongly split into exchange + IPFT (₹50/₹10 per crore). Zerodha footnote: IPFT is ₹0.01/crore on equity & futures only. Totals were unchanged. |
| 2026-10-03 | `ZERODHA-FO-2024-10-01` | `ZERODHA-FO-r2` | Assumed ₹0 brokerage at expiry and nothing for assigned shorts; the broker page says expired, exercised and assigned contracts are charged. **Old plan understated costs for positions held to expiry.** |

Superseded entries are kept in `SUPERSEDED_*` exports for audit and are never used for lookup.

## Verification status — read before relying on numbers

| Item | Source | Level |
|---|---|---|
| Current STT, exchange charges, IPFT, SEBI, stamp, GST base, brokerage, settlement brokerage, dealer fee | zerodha.com/charges (Equity tab + footnotes), read 2026-10-03 | BROKER_PUBLISHED |
| Budget 2026 STT change and 2026-04-01 effective date | secondary reporting (ICICI Direct, ClearTax) | UNVERIFIED |
| ₹20 settlement brokerage amount and that it applies to OTM expiry | page lists "expired" contracts but no amount | UNVERIFIED (conservative) |
| Exchange charges before 2026-04-01 | assumed equal to current | UNVERIFIED |
| Settlement: no exchange/SEBI/stamp charges | assumption | UNVERIFIED |
| Contract-note rounding | not documented on the page | UNVERIFIED |

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
- Dealer / auto square-off fee is modelled but only applied when an order is flagged
  `dealerPlaced`; nothing detects a broker auto square-off automatically yet.
- DP charges, interest on margin shortfall and other broker-specific extras are not modelled.
- Market impact is not modelled beyond the slippage models (TICKS, BPS, SPREAD_FRACTION).

## Example (from tests)

BUY 75 @ ₹100 on 2026-10-05: turnover ₹7,500; brokerage ₹20; STT ₹0; exchange ₹2.66; IPFT ₹0;
SEBI ₹0.01; stamp ₹0.23; GST ₹4.08; **total ₹26.98**.
