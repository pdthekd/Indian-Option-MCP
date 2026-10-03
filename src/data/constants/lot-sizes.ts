/**
 * @module data/constants/lot-sizes
 * @description F&O lot sizes for all NSE-listed derivatives as of 2026.
 *
 * Lot sizes are set by the exchange (NSE) and revised periodically — usually
 * every six months based on the underlying's price.  The values here reflect
 * the **May 2026** lot-size revision.
 *
 * The canonical source is the NSE circular under the "F&O Lot Size" section:
 * https://www.nseindia.com/regulations/circulars
 *
 * @see https://www.nseindia.com/products-services/equity-derivatives-lot-size
 */

// ---------------------------------------------------------------------------
// Index Lot Sizes
// ---------------------------------------------------------------------------

/**
 * Lot sizes for broad-market and sectoral index derivatives.
 *
 * These are traded on the NFO segment and are cash-settled.
 */
const INDEX_LOT_SIZES: Record<string, number> = {
  NIFTY: 65, // current; history in INDEX_LOT_PERIODS
  BANKNIFTY: 30,
  FINNIFTY: 60, // current (unverified)
  MIDCPNIFTY: 120,
  NIFTYNXT50: 25,
  SENSEX: 10,
  BANKEX: 15,
} as const;

// ---------------------------------------------------------------------------
// Stock Lot Sizes (F&O eligible equities)
// ---------------------------------------------------------------------------

/**
 * Lot sizes for individual stock derivatives (stock options and futures).
 *
 * Only stocks that meet SEBI's F&O eligibility criteria (MWPL, liquidity,
 * market-cap thresholds) are included.  This list covers **all major F&O
 * stocks** as of May 2026.
 *
 * > **Note:** Lot sizes change when NSE revises them.  Always cross-check
 * > with the latest NSE circular for mission-critical applications.
 */
const STOCK_LOT_SIZES: Record<string, number> = {
  // -- A --
  AARTIIND: 500,
  ABB: 125,
  ABBOTINDIA: 25,
  ABCAPITAL: 5400,
  ABFRL: 2900,
  ACC: 250,
  ADANIENT: 250,
  ADANIPORTS: 625,
  ALKEM: 125,
  AMBUJACEM: 900,
  APOLLOHOSP: 125,
  ASHOKLEY: 3000,
  ASIANPAINT: 200,
  ASTRAL: 275,
  ATUL: 75,
  AUBANK: 1000,
  AUROPHARMA: 425,
  AXISBANK: 600,

  // -- B --
  'BAJAJ-AUTO': 125,
  BAJAJFINSV: 500,
  BAJFINANCE: 125,
  BALKRISIND: 200,
  BANDHANBNK: 3600,
  BANKBARODA: 2700,
  BATAINDIA: 375,
  BEL: 3300,
  BERGEPAINT: 1100,
  BHARATFORG: 500,
  BHARTIARTL: 950,
  BHEL: 5250,
  BIOCON: 1800,
  BOSCHLTD: 25,
  BPCL: 1800,
  BRITANNIA: 100,
  BSOFT: 1000,

  // -- C --
  CANBK: 6700,
  CANFINHOME: 775,
  CHAMBLFERT: 1500,
  CHOLAFIN: 375,
  CIPLA: 325,
  COALINDIA: 1400,
  COFORGE: 75,
  COLPAL: 175,
  CONCOR: 750,
  COROMANDEL: 350,
  CROMPTON: 1500,
  CUB: 3600,
  CUMMINSIND: 200,

  // -- D --
  DABUR: 1250,
  DALBHARAT: 250,
  DEEPAKNTR: 250,
  DELTACORP: 1700,
  DIVISLAB: 100,
  DIXON: 75,
  DLF: 650,
  DRREDDY: 125,

  // -- E --
  EICHERMOT: 125,
  ESCORTS: 175,
  EXIDEIND: 1800,

  // -- F --
  FEDERALBNK: 5000,

  // -- G --
  GAIL: 3850,
  GLENMARK: 575,
  GMRINFRA: 10000,
  GNFC: 1150,
  GODREJCP: 325,
  GODREJPROP: 325,
  GRANULES: 1600,
  GRASIM: 250,
  GUJGASLTD: 1250,

  // -- H --
  HAL: 150,
  HAVELLS: 325,
  HCLTECH: 350,
  HDFC: 300,
  HDFCAMC: 150,
  HDFCBANK: 550,
  HDFCLIFE: 1100,
  HEROMOTOCO: 150,
  HINDALCO: 1075,
  HINDCOPPER: 2350,
  HINDPETRO: 1350,
  HINDUNILVR: 300,

  // -- I --
  IBULHSGFIN: 2400,
  ICICIBANK: 700,
  ICICIGI: 250,
  ICICIPRULI: 1050,
  IDEA: 50000,
  IDFC: 5000,
  IDFCFIRSTB: 7500,
  IEX: 3750,
  IGL: 1925,
  INDHOTEL: 1250,
  INDIACEM: 2900,
  INDIAMART: 150,
  INDIGO: 175,
  INDUSINDBK: 450,
  INDUSTOWER: 2300,
  INFY: 300,
  IOC: 4350,
  IPCALAB: 375,
  IRCTC: 500,
  ITC: 1600,

  // -- J --
  JINDALSTEL: 625,
  JKCEMENT: 125,
  JSWSTEEL: 675,
  JUBLFOOD: 1000,

  // -- K --
  KOTAKBANK: 400,

  // -- L --
  LALPATHLAB: 175,
  LAURUSLABS: 1100,
  LICHSGFIN: 1000,
  LT: 150,
  LTFH: 5700,
  LTIM: 100,
  LTTS: 100,
  LUPIN: 425,

  // -- M --
  'M&M': 350,
  'M&MFIN': 2000,
  MANAPPURAM: 3000,
  MARICO: 800,
  MARUTI: 100,
  MCDOWELL_N: 625,
  MCX: 200,
  METROPOLIS: 200,
  MFSL: 500,
  MGL: 500,
  MOTHERSON: 5000,
  MPHASIS: 175,
  MRF: 5,
  MUTHOOTFIN: 375,

  // -- N --
  NATIONALUM: 3750,
  NAUKRI: 125,
  NAVINFLUOR: 100,
  NESTLEIND: 25,
  NMDC: 3350,
  NTPC: 2700,

  // -- O --
  OBEROIRLTY: 350,
  OFSS: 100,
  ONGC: 3850,

  // -- P --
  PAGEIND: 15,
  PEL: 550,
  PERSISTENT: 100,
  PETRONET: 3000,
  PFC: 2600,
  PIDILITIND: 250,
  PIIND: 100,
  PNB: 6000,
  POLYCAB: 75,
  POWERGRID: 2700,
  PVRINOX: 350,

  // -- R --
  RAIN: 2800,
  RAMCOCEM: 500,
  RBLBANK: 3900,
  RECLTD: 2600,
  RELIANCE: 250,

  // -- S --
  SAIL: 5750,
  SBICARD: 500,
  SBILIFE: 375,
  SBIN: 750,
  SHREECEM: 25,
  SHRIRAMFIN: 250,
  SIEMENS: 75,
  SRF: 125,
  SUNPHARMA: 350,
  SUNTV: 1000,
  SYNGENE: 500,

  // -- T --
  TATACHEM: 500,
  TATACOMM: 250,
  TATACONSUM: 550,
  TATAELXSI: 100,
  TATAMOTORS: 1400,
  TATAPOWER: 2700,
  TATASTEEL: 5500,
  TCS: 150,
  TECHM: 350,
  TITAN: 175,
  TORNTPHARM: 175,
  TORNTPOWER: 750,
  TRENT: 100,
  TVSMOTOR: 175,

  // -- U --
  UBL: 350,
  ULTRACEMCO: 100,
  UNITDSPR: 350,
  UPL: 1300,

  // -- V --
  VEDL: 1550,
  VOLTAS: 350,

  // -- W --
  WIPRO: 1500,

  // -- Z --
  ZEEL: 3000,
  ZOMATO: 2000,
  ZYDUSLIFE: 500,
} as const;

// ---------------------------------------------------------------------------
// Merged Map
// ---------------------------------------------------------------------------

/**
 * Complete map of all F&O lot sizes — indices and stocks combined.
 *
 * Keys are uppercase NSE symbols. Values are the number of shares per lot.
 * This map is frozen at module load time and is safe to share across threads.
 */
export const LOT_SIZES: Readonly<Record<string, number>> = Object.freeze({
  ...INDEX_LOT_SIZES,
  ...STOCK_LOT_SIZES,
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Index lot sizes by TRADE DATE (derived from NSE bhavcopy files)
// ---------------------------------------------------------------------------
//
// Each contract carries its own lot size. NSE revisions roll through in
// stages: newly listed contracts get the new size first, then existing ones
// switch on a cut-over date. So:
//   - in a "uniform" period every contract of the index has the same size;
//   - in a transition window the size depends on the specific contract and
//     can only be read from that day's bhavcopy (see lotSizeFor's
//     `observations` argument). Without it, lookups FAIL CLOSED.
//
// Periods below come from the first trading day of every month,
// 2024-07-08 → 2026-10-01 (27 bhavcopy files), plus 2025-05-09..16 and
// 2026-09-28..10-01. Boundaries between samples are therefore accurate only
// to the sampling interval; anything inside a transition window must use
// observations.

export type LotSizeVerification =
  /** Read from that day's NSE bhavcopy for this exact contract. */
  | 'EXCHANGE_BHAVCOPY'
  /** All monthly bhavcopy samples in this period agree for every contract. */
  | 'BHAVCOPY_SAMPLED'
  /** Static table only (stocks) — stale. */
  | 'UNVERIFIED';

interface UniformPeriod {
  /** First trade date (inclusive) of the uniform period. */
  tradeFrom: string;
  /** Last trade date (inclusive), or null if still current. */
  tradeTo: string | null;
  lotSize: number;
}

const BHAVCOPY_SAMPLE_NOTE =
  'NSE F&O bhavcopy (NewBrdLotQty), monthly samples 2024-07 → 2026-10; consistent with the account holder\'s ' +
  'contract notes (75 in May–Aug 2025) and statement (65 from the January 2026 series)';

/** Uniform periods per index. Gaps between periods are transition windows. */
const INDEX_LOT_PERIODS: Readonly<Record<string, readonly UniformPeriod[]>> = Object.freeze({
  NIFTY: [
    { tradeFrom: '2024-07-08', tradeTo: '2024-11-01', lotSize: 25 },
    { tradeFrom: '2025-02-03', tradeTo: '2025-10-01', lotSize: 75 },
    { tradeFrom: '2026-01-01', tradeTo: null, lotSize: 65 },
  ],
  BANKNIFTY: [
    { tradeFrom: '2024-07-08', tradeTo: '2024-11-01', lotSize: 15 },
    { tradeFrom: '2025-02-03', tradeTo: '2025-04-01', lotSize: 30 },
    { tradeFrom: '2025-07-01', tradeTo: '2025-10-01', lotSize: 35 },
    { tradeFrom: '2026-01-01', tradeTo: null, lotSize: 30 },
  ],
  FINNIFTY: [
    { tradeFrom: '2024-08-01', tradeTo: '2024-11-01', lotSize: 25 },
    { tradeFrom: '2025-02-03', tradeTo: '2025-10-01', lotSize: 65 },
    { tradeFrom: '2026-01-01', tradeTo: null, lotSize: 60 },
  ],
  MIDCPNIFTY: [
    { tradeFrom: '2024-08-01', tradeTo: '2024-11-01', lotSize: 50 },
    { tradeFrom: '2025-02-03', tradeTo: '2025-04-01', lotSize: 120 },
    { tradeFrom: '2025-07-01', tradeTo: '2025-10-01', lotSize: 140 },
    { tradeFrom: '2026-01-01', tradeTo: null, lotSize: 120 },
  ],
  NIFTYNXT50: [
    { tradeFrom: '2024-07-08', tradeTo: '2024-11-01', lotSize: 10 },
    { tradeFrom: '2025-02-03', tradeTo: null, lotSize: 25 },
  ],
});

/** Per-contract lot sizes read from bhavcopy: key `${symbol}|${expiry}|${tradeDate}`. */
export type LotSizeObservations = ReadonlyMap<string, number>;

export function observationKey(symbol: string, expiry: string, tradeDate: string): string {
  return `${symbol.toUpperCase()}|${expiry}|${tradeDate}`;
}

export interface LotSizeInfo {
  symbol: string;
  lotSize: number;
  verification: LotSizeVerification;
  source: string;
  expiry: string;
  tradeDate: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lot size of a contract (symbol + expiry) as traded on `tradeDate`.
 *
 * Order of precedence:
 *  1. exact bhavcopy observation for (symbol, expiry, tradeDate);
 *  2. a uniform period covering tradeDate (index symbols);
 *  3. stocks: stale static table (UNVERIFIED).
 * Index lookups in a transition window without an observation throw.
 */
export function lotSizeFor(
  symbol: string,
  expiry: string,
  tradeDate: string,
  observations?: LotSizeObservations,
): LotSizeInfo {
  if (!ISO.test(expiry)) throw new Error(`expiry must be YYYY-MM-DD (got "${expiry}")`);
  if (!ISO.test(tradeDate)) throw new Error(`tradeDate must be YYYY-MM-DD (got "${tradeDate}")`);
  if (tradeDate > expiry) throw new Error(`Contract expiring ${expiry} does not trade on ${tradeDate}`);
  const upper = symbol.toUpperCase().trim();

  const observed = observations?.get(observationKey(upper, expiry, tradeDate));
  if (observed !== undefined) {
    return { symbol: upper, lotSize: observed, verification: 'EXCHANGE_BHAVCOPY', source: `NSE bhavcopy ${tradeDate}`, expiry, tradeDate };
  }

  const periods = INDEX_LOT_PERIODS[upper];
  if (periods) {
    const p = periods.find((x) => tradeDate >= x.tradeFrom && (x.tradeTo === null || tradeDate <= x.tradeTo));
    if (!p) {
      throw new Error(
        `${upper} lot size on ${tradeDate} falls in a lot-size transition window or outside recorded history; ` +
          'it depends on the contract — load that day\'s bhavcopy. Refusing to guess.',
      );
    }
    return { symbol: upper, lotSize: p.lotSize, verification: 'BHAVCOPY_SAMPLED', source: BHAVCOPY_SAMPLE_NOTE, expiry, tradeDate };
  }

  return {
    symbol: upper,
    lotSize: getLotSize(upper),
    verification: 'UNVERIFIED',
    source: 'Static stock lot-size table (stale; includes delisted symbols) — verify against bhavcopy',
    expiry,
    tradeDate,
  };
}

/**
 * Look up the lot size for a given F&O symbol.
 *
 * @param symbol - NSE trading symbol (case-insensitive).
 * @returns The lot size in number of shares.
 * @throws {Error} If the symbol is not found in the F&O lot-size table.
 *
 * @example
 * ```ts
 * getLotSize('NIFTY');      // 75
 * getLotSize('reliance');   // 250
 * getLotSize('BANKNIFTY');  // 30
 * ```
 */
export function getLotSize(symbol: string): number {
  const upper = symbol.toUpperCase().trim();
  const size = LOT_SIZES[upper];
  if (size === undefined) {
    throw new Error(
      `Unknown F&O symbol "${symbol}". ` +
        `It may not be listed in the derivatives segment or the lot-size ` +
        `table may need updating. Check NSE circulars for the latest list.`,
    );
  }
  return size;
}

/**
 * Check whether a symbol is available in the F&O segment.
 *
 * @param symbol - NSE trading symbol (case-insensitive).
 * @returns `true` if the symbol has a known lot size.
 *
 * @example
 * ```ts
 * isFnOSymbol('NIFTY');    // true
 * isFnOSymbol('UNKNOWN');  // false
 * ```
 */
export function isFnOSymbol(symbol: string): boolean {
  return LOT_SIZES[symbol.toUpperCase().trim()] !== undefined;
}

/**
 * Get all known F&O symbols.
 *
 * @returns A sorted array of uppercase symbols.
 */
export function getAllFnOSymbols(): string[] {
  return Object.keys(LOT_SIZES).sort();
}
