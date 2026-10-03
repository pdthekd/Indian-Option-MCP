// ────────────────────────────────────────────────────────────────────────────
// Base Data Provider – abstract interface that every concrete provider must
// implement.  All model types are declared locally so the file is
// self-contained even when the models package hasn't been created yet.
// ────────────────────────────────────────────────────────────────────────────

// ── Inline model types (mirrors src/data/models/*) ─────────────────────────

/**
 * Single leg of an option (CE or PE).
 *
 * `null` means "not provided by the source / not known". It must never be
 * replaced with 0: a zero IV, bid, ask or OI change is a real (and very
 * different) market value.
 */
export interface OptionData {
  strikePrice: number;
  expiryDate: string;          // ISO-8601 yyyy-MM-dd
  optionType: 'CE' | 'PE';
  /** Last traded price; null when the contract has not traded / not provided. */
  lastPrice: number | null;
  change: number | null;
  pChange: number | null;
  /** Open interest. Units: NSE = contracts, Kite = units (shares). */
  openInterest: number | null;
  changeinOpenInterest: number | null;
  totalTradedVolume: number | null;
  /** Implied volatility in PERCENT (e.g. 14.5), as published by the source. */
  impliedVolatility: number | null;
  bidQty: number | null;
  bidPrice: number | null;
  askQty: number | null;
  askPrice: number | null;
  underlyingValue: number | null;
}

/** Data-quality classification attached to every chain. */
export type DataQualityStatus = 'FULL' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE';

export interface DataQuality {
  status: DataQualityStatus;
  /** Which endpoint produced the data. */
  source: 'nse-primary' | 'nse-fallback' | 'zerodha';
  /** Fields the source does not supply for this chain (always null in rows). */
  unavailableFields: string[];
  /** Human-readable reasons for any status other than FULL. */
  reasons: string[];
  /** Source-published timestamp (ISO-8601 UTC), or null if not provided. */
  asOf: string | null;
  /** When this process fetched the data (ISO-8601 UTC). */
  fetchedAt: string;
}

/** One strike row containing both CE and PE sides */
export interface OptionChainRow {
  strikePrice: number;
  expiryDate: string;
  CE?: OptionData;
  PE?: OptionData;
}

/** Complete option-chain snapshot for a symbol + expiry */
export interface OptionChainData {
  symbol: string;
  underlyingValue: number;
  /** The single expiry ALL rows belong to (ISO yyyy-MM-dd). */
  expiryDate: string;
  expiryDates: string[];       // all available expiries
  /** Strikes present in `rows` (for the resolved expiry). */
  strikePrices: number[];
  rows: OptionChainRow[];
  /** Source timestamp as published (may be in NSE format), or '' if absent. */
  timestamp: string;
  dataQuality: DataQuality;
  totalCEOpenInterest: number;
  totalPEOpenInterest: number;
  totalCEVolume: number;
  totalPEVolume: number;
}

export interface QuoteData {
  symbol: string;
  lastPrice: number;
  change: number;
  pChange: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

export interface MarketStatus {
  market: string;
  status: 'Open' | 'Closed' | 'Pre-open' | 'Post-close';
  timestamp: string;
}

export interface CandleData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

export interface Instrument {
  instrumentToken: string;
  exchangeToken: string;
  tradingSymbol: string;
  name: string;
  lastPrice: number;
  expiry: string;             // ISO-8601 date
  strike: number;
  tickSize: number;
  lotSize: number;
  instrumentType: string;     // CE | PE | FUT | EQ | IDX …
  segment: string;
  exchange: string;
}

// ── Provider interface & abstract base class ───────────────────────────────

export interface DataProvider {
  readonly name: string;

  /** Initialize the provider (login, fetch instrument master, etc.) */
  initialize(): Promise<void>;

  /** Get full option chain for a symbol */
  getOptionChain(symbol: string, expiryDate?: string): Promise<OptionChainData>;

  /** Get market quote for a symbol */
  getQuote(symbol: string): Promise<QuoteData>;

  /** Get multiple quotes at once */
  getQuotes(symbols: string[]): Promise<Map<string, QuoteData>>;

  /** Get all available expiry dates for a symbol */
  getExpiryDates(symbol: string): Promise<string[]>;

  /** Get spot / underlying price */
  getSpotPrice(symbol: string): Promise<number>;

  /** Get historical OHLCV data */
  getHistoricalData(
    symbol: string,
    from: Date,
    to: Date,
    interval?: string,
  ): Promise<CandleData[]>;

  /** Get list of F&O instruments */
  getInstruments(exchange?: string): Promise<Instrument[]>;

  /** Check market status */
  getMarketStatus(): Promise<MarketStatus>;

  /** Check if provider is ready */
  isReady(): boolean;
}

export abstract class BaseProvider implements DataProvider {
  abstract readonly name: string;
  protected _ready = false;

  abstract initialize(): Promise<void>;
  abstract getOptionChain(symbol: string, expiryDate?: string): Promise<OptionChainData>;
  abstract getQuote(symbol: string): Promise<QuoteData>;
  abstract getQuotes(symbols: string[]): Promise<Map<string, QuoteData>>;
  abstract getExpiryDates(symbol: string): Promise<string[]>;
  abstract getSpotPrice(symbol: string): Promise<number>;
  abstract getHistoricalData(
    symbol: string,
    from: Date,
    to: Date,
    interval?: string,
  ): Promise<CandleData[]>;
  abstract getInstruments(exchange?: string): Promise<Instrument[]>;
  abstract getMarketStatus(): Promise<MarketStatus>;

  isReady(): boolean {
    return this._ready;
  }
}
