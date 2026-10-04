# Historical Option Data Sources (research, 2026-10-03)

Goal: point-in-time data good enough to backtest NIFTY option strategies **net of costs**.
Requirements, most important first: expired contracts · intraday timestamps · **bid/ask**
(entry/exit is paid at the spread, not at LTP) · open interest · settlement prices · lot size
in force · licence that permits private research.

Tags: **[O]** read on the provider's official page or document that day · **[T]** tested
here by downloading real data · **[S]** secondary source · **[?]** not stated.

## Summary

| Source | Intraday | Bid/ask | Expired contracts | History | Cost | Fit |
|---|---|---|---|---|---|---|
| **NSE F&O bhavcopy** (UDiFF CSV, nsearchives) | No (1 row/contract/day) | **No** | Yes, every contract | Daily files; new format since 2024-07-08, older format before [S] | Free | Settlement, OI, lot size, expiry lists, EOD marks [T] |
| **Dhan** `POST /charts/rollingoption` | 1/5/15/25/60-min | **No** | Yes | Last 5 years [O] | Broker account; data-plan cost [?] | Best cheap intraday source; strikes are ATM-relative (ATM±10 index) [O] |
| **Upstox** expired-instruments candles | 1/3/5/15/30-min, day | **No** | Yes, by exact contract | Depth [?] | Upstox Plus plan; price [?] [O] | Exact-contract intraday OHLC + OI; community reports gaps [S] |
| **Zerodha Kite** historical | minute+ | No | **No** for options unless tokens were cached beforehand [O] | — | ₹500/mo Connect | Not usable for expired options |
| **Global Datafeeds** | tick (1 week), 1-min (3 months) | Live L1 yes; historical [?] | Options EOD 1 month [O] | Short | Paid [?] | Forward/live use, not research history |
| **TrueData** | claims historical ticks | [?] | [?] | [?] | Paid [?] | Website gives no specifics — needs a sales enquiry |
| **NSE Data & Analytics** historical order & trade data | Every order entry/modify/cancel and trade, sub-second timestamps [O] | **Yes, by rebuilding the order book** | Yes | Spec dates from 2007; F&O format changes 2020–2024 [O] | Quote on request [?]; institutional | Only source of true historical bid/ask; very large files (up to 18 streams/day) and serious engineering |

## What was verified

- **Bhavcopy** — downloaded `BhavCopy_NSE_FO_0_0_0_20250509_F_0000.csv.zip` from
  `nsearchives.nseindia.com` (34,569 rows). Columns include `XpryDt, StrkPric, OptnTp, OpnPric,
  HghPric, LwPric, ClsPric, SttlmPric, OpnIntrst, ChngInOpnIntrst, TtlTradgVol, UndrlygPric,
  NewBrdLotQty`. For NIFTY 24000 PE (15 May 2025 expiry): range ₹200.60–₹329.45, settlement
  ₹238.95, lot 75. The account holder's contract-note fills that day (₹219.50–₹276.70) lie
  inside that range — the two sources are consistent. `OpnIntrst` is in **units**, not contracts.
- **NSE order & trade spec** v1.15 (13 Aug 2025) — record layouts for F&O orders (entry=1,
  cancel=3, modify=4; limit price in paise; market/IOC/stop flags) and trades; delivery by SFTP
  (last 3 days only), downloader client, or cloud. No prices in the document.
- **Dhan, Upstox, Kite** — official API pages read; none return historical bid/ask.

## Consequences for the system

1. **No affordable source gives historical bid/ask.** Any backtest on OHLC/LTP data must treat
   the spread as an explicit, pessimistic cost (the SPREAD_FRACTION/TICKS slippage models and
   the WORSE/SEVERE scenarios), never as zero. Results must be labelled accordingly.
2. **Start recording our own point-in-time quotes now.** During market hours the live chain
   provides bid/ask (with `DATA QUALITY: FULL`). A recorder that snapshots selected strikes
   every minute builds a private bid/ask history at zero cost, and calibrates the spread
   assumptions used on OHLC history. Months of recording are needed before it is useful.
3. **Dhan's ATM-relative series** suits strategies defined relative to ATM, but a fixed-strike
   position held while spot moves must be mapped across the ATM±n series (or use Upstox's
   exact-contract candles).
4. **Bhavcopy is the reference layer**: settlement prices for expiry P&L, lot sizes by date,
   listed expiries, OI — and a cross-check for any vendor data.

## Recommendation

| Step | What | Cost |
|---|---|---|
| 1 | Bhavcopy ingester (reference layer) + lot-size/expiry cross-checks | Free |
| 2 | Forward bid/ask recorder from the live chain (market hours) | Free |
| 3 | One intraday candle source: Dhan rolling options **or** Upstox Plus — whichever account you have or prefer; confirm data-plan price and terms first | Low |
| 4 | Backtests on (1)+(3) with spread costs from (2) and WORSE/SEVERE scenarios | — |
| 5 | Only if a strategy survives 4: consider NSE historical order data (or a vendor quote) to test fills against real bid/ask | High |

Licensing: all of the above are for private research; none permit redistribution. Store
downloaded data outside the repository.

## Implemented (steps 1 and 2)

Both tools write to `~/.options-hq/data` (override with `OPTIONS_HQ_DATA_DIR`; a directory inside the
repository is refused). Neither is part of the MCP server.

```bash
npm run build
node dist/bhavcopy-cli.mjs --from 2026-09-01 --to 2026-09-30            # EOD reference data
node dist/record-quotes-cli.mjs --symbols NIFTY,BANKNIFTY --interval 60  # bid/ask recorder (market hours)
```

- **Bhavcopy ingester** (`src/history/bhavcopy.ts`): downloads once per date (raw zip kept,
  never overwritten; SHA-256 in `manifest.jsonl`), stores a normalised index-option extract,
  skips weekends/official holidays, 1.5 s between requests, 400-day cap per run. Exposes an
  end-of-day `HistoricalMarketDataProvider` whose data is treated as known only from 20:00 IST
  (no same-day look-ahead), with `bid/ask = null`.
- **Quote recorder** (`src/history/quote-recorder.ts`): during market hours snapshots ATM±N
  strikes for the nearest and next expiry, writes only `FULL`-quality data, skips unchanged
  source timestamps, keeps missing values null. `spreadStats()` summarises recorded spreads for
  calibrating slippage models.

### First finding from the bhavcopy: lot sizes change by trade date, per contract

Running the lot-size cross-check over 37 downloaded files showed the expiry-keyed lot-size rule
was wrong (e.g. NIFTY contracts expiring 2026–2029 traded at 75 in May 2025; BANKNIFTY near
contracts were 30 while later ones were 35). Revisions roll through in stages: new contracts get
the new size first, then existing contracts switch on a cut-over date. The lot-size model is now
keyed by **trade date** with uniform periods derived from monthly bhavcopy samples
(1,277 contract-days: 1,065 match, 0 mismatch, 212 in transition windows, where the day's
bhavcopy is required and lookups otherwise fail closed).

### Full backfill (2026-10-04)

All 554 trading days from 2024-07-08 to 2026-10-01 downloaded with 0 errors (~1 MB each, ~600 MB raw). Two
cross-checks came out of it:

- **Holidays.** Every 2025 weekday without a bhavcopy is an official holiday (13 of 14; the 14th,
  21 Oct, had a Muhurat session). In 2026 one unlisted weekday had no file: **15 Jan 2026**, a special
  closure for the Maharashtra municipal elections announced after the annual list (NSE/CD/72233).
  It is now in the holiday list. Lesson: annual holiday lists change; bhavcopy availability is the check.
- **Lot sizes.** `dist/derive-lot-sizes-cli.mjs` rebuilds `src/data/constants/lot-history.generated.ts`
  from every raw file (all index and stock contracts): 285 symbols, uniform periods by trade date,
  transition days excluded. It captures corporate actions (RELIANCE 250 → 500 after its 1:1 bonus,
  ZOMATO renamed ETERNAL) that a hand-typed table misses.

## Open questions (need the account holder or a vendor)

- Dhan data-API pricing and terms; Upstox Plus price; whether TrueData sells historical
  option ticks with bid/ask and at what price; NSE Data & Analytics quote for F&O order data.

## Sources

- https://dhanhq.co/docs/v2/expired-options-data/ [O]
- https://upstox.com/developer/api-documentation/get-expired-historical-candle-data/ [O],
  https://upstox.com/developer/api-documentation/expired-instruments/ [O]
- https://kite.trade/docs/connect/v3/historical/ [O]
- https://globaldatafeeds.in/global-datafeeds-apis/global-datafeeds-apis/introduction/type-of-data-available/ [O]
- https://www.truedata.in/ [O, no specifics]
- https://nsearchives.nseindia.com/web/sites/default/files/inline-files/Hist_Order_Trade_Data_1.15.pdf [O]
- https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20250509_F_0000.csv.zip [T]
- https://github.com/SantoshSrinivas79/NSE-FNO-Data-bank (bhavcopy archive paths) [S]
