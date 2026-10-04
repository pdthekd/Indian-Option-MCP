# Cost Model Audit (Foundation Phase 3–4)

Date: 2026-10-04. Scope: `src/costs/transaction-cost-engine.ts`, `src/config/charges/{nse-fo,brokerage}.ts`,
`src/pnl/pnl-engine.ts`, and how the backtest engine uses them.

## Verdict

**PASS WITH LIMITATIONS.** Option entry/exit charges are reconciled to the paisa against real contract
notes for May–Aug 2025. One cost defect was found and corrected (brokerage on options expiring
worthless). Three cost areas remain unverified, listed below; none could change the reference
strategy's verdict, because its **gross** result is already negative.

## What was checked

| Component | Rate / rule in model | Evidence | Status |
|---|---|---|---|
| Brokerage, options | ₹20 per **executed order** (multi-fill orders charged once) | 41 contract notes, 266 orders, 0 mismatches | VERIFIED |
| STT, option sell premium | 0.10 % (2024-10-01 → 2026-03-31); 0.15 % from 2026-04-01 | 41 notes (0.10 %); Budget 2026 secondary reporting (0.15 %) | VERIFIED / SOURCED |
| STT rounding | paisa, then rupee half-up on the day aggregate | Observed ₹12.495 → ₹12.50 → ₹13 on a note | VERIFIED |
| Exchange transaction | 0.03553 % of premium (no separate IPFT for options) | 41 notes | VERIFIED for May–Aug 2025 |
| SEBI fee | ₹10 / crore | 41 notes | VERIFIED |
| Stamp duty | 0.003 % buy side, rupee-rounded on contract notes | 41 notes | VERIFIED |
| GST | 18 % on brokerage + exchange + SEBI (CGST 9 % + SGST 9 %) | 41 notes; one day ₹0.02 off (unexplained) | VERIFIED (±₹0.02) |
| Exercise STT (long ITM at expiry) | 0.125 % → 0.15 % of intrinsic value | Statute / secondary reporting | SOURCED, not seen on a note |
| Settlement brokerage | ₹20 per ITM contract exercised / assigned; **₹0 when expiring OTM/ATM** | Zerodha support article (read 2026-10-04) | SOURCED, not seen on a note |
| Exchange / SEBI / stamp on exercise | assumed none | — | UNVERIFIED |
| Futures charges | 0.02 % → 0.05 % STT, 0.00183 % exchange, IPFT ₹0.01/crore | Broker page | Not used by the reference strategy |

Reconciliation is now a reusable tool: `node dist/reconcile-cli.mjs <notes.json>` (module
`src/costs/contract-note-reconciliation.ts`). Input notes are produced by
`scripts/contract_note_xlsx_to_json.py`, which drops all personal fields, hashes order numbers and
refuses to write inside a git tree. Result on the account holder's notes (aggregate only):

```
Contract notes: 41 (2025-05-09 → 2025-08-14), fills 310, orders 266; plan ZERODHA-FO-r3
Exact on every component: 40/41
Total charges: model ₹8624.23 vs reported ₹8624.25 (diff ₹-0.02); max daily |diff| ₹0.02
VERDICT: PASS
```

## Defect found: brokerage on worthless expiry (r2 → r3)

Plan `ZERODHA-FO-r2` charged ₹20 + GST settlement brokerage on **every** leg held to expiry,
including legs that expire worthless. Zerodha's support article says index options that expire
OTM/ATM are not charged; only ITM contracts that are exercised or assigned are. The broker charges
page sentence "brokerage is also charged on expired … contracts" was read too broadly.

- New default plan `ZERODHA-FO-r3` charges settlement brokerage only on EXERCISED / ASSIGNED.
- `ZERODHA-FO-r2` remains selectable, marked SUPERSEDED, **only** to reproduce the original result.
- Effect on the reference run: 380 worthless legs × ₹23.60 = **₹8,968.00 less cost**; nothing else
  changes. Net moves from −₹69,976.23 to −₹61,008.23.
- Cross-check: r3 brokerage ₹9,040 = 416 entry orders × ₹20 + 36 ITM settlement legs × ₹20, and the
  tail analysis independently counts 24 short-breached + 6 fully-breached trades = 24 + 12 = 36 ITM legs.

Tests changed because of this (each documents the reason in the test):
`costs-pnl-tax.test.ts` (OTM expiry brokerage 20 → 0; short expiring worthless costs 33.6 → 10) and
`backtest-engine.test.ts` (settlement brokerage on one ITM leg, not four).

## Per-order vs contract-note rounding

The backtest charges each order separately, rounded to the paisa
(`calculateOrderCosts`). Contract notes round STT and stamp duty once per day to the rupee.
For one-lot trades the difference is below ₹1 per day and in either direction; it is not material to
any result here. `calculateContractNoteCosts` reproduces the note rounding for reconciliation.

## Cost breakdown of the reference run (audited, r3)

| Component | ₹ | Per trade |
|---|---:|---:|
| Brokerage | 9,040.00 | 86.92 |
| GST | 1,673.07 | 16.09 |
| STT | 655.05 | 6.30 |
| Exchange | 254.55 | 2.45 |
| Stamp | 7.20 | 0.07 |
| SEBI | 0.36 | 0.00 |
| **Charges** | **11,630.23** | **111.83** |
| Spread (EOD_PESSIMISTIC_V1) | 15,118.25 | 145.37 |
| **All costs** | **26,748.48** | **257.20** |

The spread assumption is the largest and least certain cost (see EXECUTION_CALIBRATION.md).
Brokerage dominates the charges because 1-lot premiums are small (₹20 per order regardless of size).

## Remaining limitations

1. **No contract note after 2026-04-01.** The 0.15 % STT rates come from secondary reporting of
   Budget 2026; 26 of 104 trades fall in that period.
2. **No contract note with a position held to expiry.** Settlement brokerage and exercise STT are
   sourced from the broker's support article and the statute, not reconciled.
3. **Oct 2024 – Apr 2025 exchange rate** is assumed equal to the reconciled May–Aug 2025 rate.
4. Exchange, SEBI and stamp on exercise are assumed zero (UNVERIFIED, small).
5. Dealer / auto square-off fee (₹50 + GST) is modelled but never applied by the backtest, which
   holds to settlement and never auto-squares off.

Action to close 1–2: reconcile one post-April-2026 contract note that includes an expiry-day ITM
settlement before any shadow or paper result is trusted for costs.
