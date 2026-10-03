# Functional Audit (Phase 2)

Every source file under `src/` at baseline `a00d3ea` was read. README claims were not taken
on trust. Defects marked **[VERIFIED]** were reproduced numerically against the compiled
baseline code (probe script, 2026-10-03); the rest are by code inspection.

Severity: **CRITICAL** = can silently understate risk or misstate money; **HIGH** = wrong
numbers in normal use; **MEDIUM** = wrong in edge cases / misleading; **LOW** = cosmetic.

## 0. Headline defects

| ID | Area | Defect | Sev. | Fixed on audit branch? |
|---|---|---|---|---|
| F1 | Payoff | Unlimited **loss on the upside** is never detected. Naked short call (K=24000, prem 200, lot 75) reports *Max Loss −₹2,55,000* instead of *Unlimited* **[VERIFIED]** | CRITICAL | Yes — analytic tail-slope detection |
| F2 | Payoff | Short put reported as *Unlimited* loss although it is bounded at S→0 ((K−prem)·qty·lot) **[VERIFIED]** | MEDIUM | Yes |
| F3 | Margin | Any 2-leg same-action short (straddle/strangle) is classified as a "spread"; margin = worst loss within ±10% of spot — naked short straddle margin massively understated. Any 3 legs = "butterfly", any 2+2 = "iron spread" regardless of strikes/qty | CRITICAL | Tool now labels output *heuristic, not SPAN; do not use for risk*. Engine replacement required (broker margin API) |
| F4 | NSE chain | When no `expiry` is passed, the primary endpoint returns rows for **all expiries**; they are merged into one chain. Max pain, PCR, OI, scanners and `build_strategy` premiums then mix expiries; the premium map (`strike-type`) is overwritten by whichever expiry comes last | CRITICAL | Yes — chain is always filtered to one resolved expiry |
| F5 | NSE chain | With an explicit non-nearest expiry, totals come from `filtered.CE/PE` which NSE computes for the **nearest** expiry only | HIGH | Yes — totals always recomputed from returned rows |
| F6 | Math | `utils/math.normCDF` mixes A&S 7.1.26 (erf) coefficients with the wrong argument scaling. Φ(1)=0.8703 (true 0.8413), Φ(−1)=0.1297 (true 0.1587) **[VERIFIED]** — used by POP | HIGH | Yes — single accurate implementation shared by all modules |
| F7 | POP | Profit region is *guessed* from the CREDIT/DEBIT label. A debit butterfly (profits **between** BEs) gets POP 89.5% instead of ≈10% **[VERIFIED]** | HIGH | Yes — new `probabilityOfProfitFromLegs` evaluates the real payoff; old tool now requires legs |
| F8 | Sizing | `position_sizing` multiplies `max_loss_per_lot` by `lot_size`, so a ₹5,000-per-lot max loss is treated as ₹3.75 lakh → 0 lots **[VERIFIED]**. Units contradict the tool description | HIGH | Yes — explicit per-lot rupee semantics, validated inputs |
| F9 | Expiry calendar | Encodes the pre-2025 regime (NIFTY Thu, BANKNIFTY Wed, FINNIFTY Tue, MIDCPNIFTY Mon weeklies; monthly = last **Thursday**). Since 2025-09-01 NSE index/stock derivatives expire on **Tuesday** (monthly = last Tuesday); BANKNIFTY/FINNIFTY/MIDCPNIFTY weeklies discontinued. `next_expiry NIFTY weekly` from 2026-10-03 returns 2026-10-08 (Thu) **[VERIFIED]** | HIGH | Tool output now states "computed, unverified — use exchange expiry list"; calendar rules flagged. Authoritative source must be the exchange/broker instrument master |
| F10 | Lot sizes | Hard-coded table is stale: NIFTY 75 (NSE revised to 65 for contracts from Jan 2026, per broker bulletins — verify against NSE circular), includes merged/delisted symbols (HDFC, IDFC, IBULHSGFIN…). Used for payoff ₹, max pain, margin | HIGH | **Partly fixed:** index lot sizes versioned by contract expiry (NIFTY 75 → 65 from Jan-2026 series; 75 observed on contract notes, 65 user-provided). BANKNIFTY/FINNIFTY/MIDCPNIFTY revisions UNVERIFIED. Stocks still from the stale static table |
| F11 | Dates | `daysToExpiry` depends on the host time zone: for expiry 2026-10-06 returns 3 on an IST host and 2 on a UTC host **[VERIFIED]**. Whole-day granularity; expiry-day T is floored at 1 hour regardless of time (expiry is 15:30 IST) | HIGH | Yes — `timeToExpiryYears` computed from instants to 15:30 IST, TZ-independent |
| F12 | Data quality | NSE fallback endpoint has no IV, bid, ask, bid/ask qty or change-in-OI; provider writes **0** for all of them. Zerodha provider writes IV=0 always and changeInOI=0 (reads non-existent `oiDayChange`). Zero is then rendered as a real value (IV 0.0%, "+0" OI change, expected move ₹0) | CRITICAL (for any strategy use) | Yes — fields are now `number \| null` plus per-chain `dataQuality` (FULL/DEGRADED/STALE/UNAVAILABLE) and a list of unavailable fields; tools print `n/a` |
| F13 | Fallback chain | `/api/liveEquity-derivatives` lists only the **most active** contracts, not the full chain. Max pain/PCR/OI computed on it are not comparable to the full chain, but were presented identically | HIGH | Yes — marked `DEGRADED` with reason |
| F14 | market_overview | ATM IV from NSE is already in percent, then multiplied by 100 again → "1450.0%" | HIGH | Yes |
| F15 | Strategy builder | Missing strike premium silently becomes **0** (`?? 0`) → P&L, credit/debit and breakevens wrong. Stock strike interval defaults to 50 → legs at non-existent strikes. Calendar spreads use the **same** expiry for both legs (net 0) | HIGH | Premium 0 now rejected (missing premium → error listing the missing legs); calendars marked unsupported |
| F16 | custom_strategy | Unknown strike → premium 0, silently | HIGH | Yes — error |
| F17 | Zerodha | Index spot lookups use `NSE:NIFTY` (Kite key is `NSE:NIFTY 50`, `NSE:NIFTY BANK`) → index chains fail; pre-open branch `t>=900 && t<555` is unreachable; `getInstruments(exchange)` replaces the full cache with one exchange; 110 ms global gap exceeds Kite's documented 1 req/s quote limit | HIGH | Spot key mapping + pre-open fixed; others documented |
| F18 | Calendars | Two different, unverified 2026 holiday lists (`expiry-calendar.ts` vs `utils/date.ts`) disagree on ≥8 dates | MEDIUM | **Fixed for 2026:** single shared list from NSE circular NSE/CMTR/71775 (6 Tuesday holidays now shift NIFTY expiries). 2025 list UNVERIFIED; later years UNKNOWN |
| F19 | Staleness | `timestamp` falls back to *now* when the source omits it; no age check anywhere; 10 s cache returns data without age | HIGH | Yes — `asOf`, `fetchedAt`, `ageSeconds`, and STALE classification |
| F20 | PCR | Thresholds in engine (1.2 / 0.8) contradict tool text (1.0 / 0.7). Labels BULLISH/BEARISH are unvalidated heuristics | MEDIUM | Text aligned; labelled *heuristic, no validated edge* |

## 1–24. Area-by-area

### 1. NSE option chain (primary `/api/option-chain-indices|equities`)
- Formula/mapping: raw fields copied; `bidprice` vs `bidPrice` both handled.
- Units: OI in **contracts** (NSE convention); IV in **percent**; prices ₹/unit.
- Defects: F4, F5, F12, F19. Undocumented endpoint, cookie-gated; may break without notice.
- Edge cases: empty `records.data` → falls back (good). Missing `underlyingValue` → 0 (now `UNAVAILABLE`).

### 2. NSE fallback `/api/liveEquity-derivatives`
- Contains only top-traded contracts; F12, F13. `strikePrice` missing → 0 strike row (now dropped).
- If requested expiry absent → empty rows returned silently (now `UNAVAILABLE`).

### 3. Zerodha provider
- Not exercised (no credentials; none should be used). Findings by inspection: F17; quote
  fields `oiDayChange`, `previousClose` do not exist in Kite's quote schema (Kite returns
  `oi_day_high/low`, `ohlc.close`) → change-in-OI and pChange always 0. IV never provided.
  Uses `last_price` (LTP) not mid. `normaliseKiteDate` uses `new Date(raw)` — safe for
  `yyyy-mm-dd`, TZ-unsafe for any other format.

### 4. Instrument handling
- `InstrumentCache` is never used by the server. NSE provider returns no instruments.
  Tick size and lot size from Kite CSV are parsed but never used for validation.

### 5. Expiry handling — F9, F11, F18. Expiry is never validated against the provider's list
  before use; an unknown expiry string silently yields an empty or wrong chain.

### 6. Lot sizes — F10. `getLotSize` throws for unknown symbols (good), but values are stale.

### 7. Black-Scholes (`engine/black-scholes.ts`)
- Formula: Merton BSM with continuous yield q. d1, d2 standard. Verified vs Hull Ex. 15.6
  (S=42, K=40, r=10%, σ=20%, T=0.5): C=4.7594 (ref 4.76), P=0.8086 (ref 0.81).
- normCDF: A&S 26.2.17, |ε|<7.5e-8 — adequate (absolute price error < ₹0.002 at S=25,000).
- Assumptions: European exercise (correct for NSE index options; NSE stock options are also
  European since 2011), constant σ and r, q=0 everywhere in tools (index dividend yield ignored).
- Units: T in years (calendar/365). Theta per **calendar** day. Vega, rho per **1 percentage
  point**. Vanna per 1.00 σ; volga per 1.00 σ² — inconsistent with vega's scaling (documented).
- Edge cases: S≤0 → 0 (put returns undiscounted K); T≤1e-10 → intrinsic; σ≤1e-10 → discounted
  forward intrinsic. **K≤0, NaN, ±Infinity not rejected** in engine (tools now reject).

### 8. IV (`engine/implied-volatility.ts`)
- Newton-Raphson from Brenner-Subrahmanyam guess, bisection fallback on [0.1%, 500%].
  Tolerance ₹0.001 absolute. Round-trip test σ=14% recovered to 1e-9 **[VERIFIED]**.
- Rejects price ≤ 0, below intrinsic − ₹0.10, above no-arbitrage upper bound + ₹0.10.
- Weakness: below-intrinsic check uses undiscounted intrinsic (deep ITM puts with r>0 can
  legitimately trade below K−S). Uses LTP, which may be stale vs underlying (asynchronous
  prices produce spurious IV). `calculateIVForChain` uses its own TZ-dependent date parser
  and silently falls back to "now" on unparseable dates (T≈0). Not used by tools.

### 9. Greeks — see 7. `calculate_greeks` text claims theta "loses" even when theta>0
  (deep ITM puts). `what_if_greeks` hard-codes r=7%.

### 10. Payoff — F1, F2. Range fixed at ±15% of spot; max profit/loss outside the grid
  (wide condors, far strikes) is missed. Breakevens by linear interpolation on a grid that
  includes each strike ±0.01 — exact for piecewise-linear expiry payoff once kinks are included.
  Costs are **not** included anywhere: every "max profit", "breakeven" and "P&L" is **gross**.

### 11. Max pain — standard writer-payout minimisation over strikes; F4 corrupts it without
  explicit expiry. Multiplying by lotSize only scales (argmin unchanged) but with NSE OI in
  contracts and Kite OI in shares the absolute "pain" numbers are inconsistent across
  providers. Max pain has no validated predictive value; labelled as such.

### 12. PCR — F20, F4. Zero call OI → PCR 0 (should be undefined).

### 13. OI analysis — "support/resistance" from max OI is a convention, not a validated
  signal. With fallback data, change-in-OI is all zero → `oi_change_analysis` printed strike ₹0.

### 14. IV surface — smile/skew filter IV>0 (good, but relied on zero-as-missing). Term
  structure, IV rank/percentile, HV vs IV have no data source (no history) and are not exposed.
  `hvVsIvAnalysis` emits trade suggestions ("Favor option SELLING") — advisory text, not exposed.

### 15. Expected move — S·σ·√(DTE/365)·k. DTE whole calendar days (F11); used
  `chain.expiryDates[0]` even when another expiry was requested; σ=0 when IV unavailable → ±₹0.

### 16. POP — F6, F7. Driftless log-normal (−σ²/2), no r; uses gross breakevens (ignores costs).

### 17. Kelly — `(pW − qL)/W`, correct formula; comment claims half-Kelly but returns full Kelly
  (capped at 1). Not exposed via tools. Must never be fed with in-sample estimates.

### 18. Position sizing — F8. No validation of capital ≤ 0 or risk% > 100.

### 19. Margin — F3. No SPAN, no exposure-margin rules per instrument, no premium offset rules,
  hard-coded IV 15%. Must be replaced by broker margin API (Kite `/margins/basket`) before
  any risk use.

### 20. Market status — server uses clock + local holiday list (`utils/date`), not the
  exchange endpoint; ignores special/muhurat sessions and unscheduled closures; Zerodha
  provider has an unreachable pre-open branch (F17).

### 21. Caching — LRU + TTL 10 s + in-flight coalescing; errors not cached (good). No age
  surfaced (F19). Cache key uses raw expiry string.

### 22. Retries — NSE: 3 attempts, 15 s timeout each, linear back-off, session refresh on
  401/403/HTML. Worst case > 60 s per call and the global queue serialises all calls.
  Kite: no retries.

### 23. Rate limiting — NSE ≥3 s gap (self-imposed). Kite 110 ms gap global; violates
  1 req/s for `/quote` when >1 batch.

### 24. Error handling — tool exceptions surface as MCP tool errors (SDK). Partial failures
  in `getQuotes` are swallowed (logged only). `market_overview` swallows all errors into
  "Data unavailable".

## Costs, taxes and P&L in baseline

**None.** No brokerage, STT, exchange charges, GST, SEBI fees, stamp duty or slippage are
modelled anywhere. Every profit/loss figure produced by baseline tools is **gross** and must
be read as *PROFITABLE BEFORE COSTS BUT NOT VALIDATED AFTER COSTS* at best.
Addressed by the new cost / P&L / tax engines (TRANSACTION_COST_MODEL.md, TAX_MODEL.md).
