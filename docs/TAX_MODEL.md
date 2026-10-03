# Tax Model (Phase 8)

Code: `src/tax/tax-model.ts`, rules in `src/config/tax/india.ts`. MCP tool: `estimate_tax`.

> **ESTIMATE ONLY — not tax advice and not a confirmed tax liability.** Results depend on
> individual circumstances. Consult a qualified tax professional.

## Layering

| Layer | Where | Per trade? |
|---|---|---|
| Transaction-level statutory charges (STT, stamp duty, exchange, SEBI, GST) | TransactionCostEngine → **in NET trading P&L** | yes |
| Gross trading P&L | PnLEngine | yes |
| NET trading P&L | PnLEngine | yes |
| Estimated taxable income | TaxModel | **annual** |
| Estimated tax liability / after-tax estimate | TaxModel | **annual** |

Income tax is never subtracted from individual trades.

## Rules encoded

| Field | Value |
|---|---|
| Rule versions | `IN-NEW-REGIME-FY2025-26-v1`, `IN-NEW-REGIME-FY2026-27-v1` |
| Regime | New regime only |
| F&O treatment | Non-speculative business income at slab rates |
| Slabs | 0–4 L nil; 4–8 L 5 %; 8–12 L 10 %; 12–16 L 15 %; 16–20 L 20 %; 20–24 L 25 %; > 24 L 30 % |
| Rebate | up to ₹60,000 for resident individuals with total income ≤ ₹12 L, with marginal relief |
| Surcharge | 10 % > ₹50 L, 15 % > ₹1 Cr, 25 % > ₹2 Cr (marginal relief **not** modelled) |
| Cess | 4 % |
| Sources | secondary summaries (ClearTax, BankBazaar), retrieved 2026-10-03 — **UNVERIFIED** |

## Method

`estimatedTaxAttributableToTrading = tax(otherIncome + max(0, netTradingPnL − tradingExpenses)) − tax(otherIncome)`.

## Not modelled (each can change the answer materially)

- Loss set-off and 8-year carry-forward (a trading loss returns 0 tax, not a credit).
- Old regime; presumptive taxation; tax-audit requirements and costs.
- Surcharge marginal relief (model overstates tax near thresholds — conservative).
- Advance-tax instalments and interest.
- Income-tax Act 2025 section mapping (effective 2026-04-01) — not verified against statute.
- Whether STT is deductible under the new Act — assumed yes (already removed in net P&L).
