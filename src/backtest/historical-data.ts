/**
 * @module backtest/historical-data
 *
 * Interface for POINT-IN-TIME historical market data. No implementation in
 * this repository has real historical option data yet; the live NSE provider
 * cannot be used for backtesting.
 *
 * `PointInTimeGuard` wraps any provider and throws if a returned record is
 * time-stamped after the simulated decision time (look-ahead bias).
 */

export interface HistoricalOptionQuote {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  bid: number | null;
  ask: number | null;
  ltp: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  /** When this observation became known (exchange time). */
  timestamp: Date;
}

export interface HistoricalChainSnapshot {
  underlying: string;
  underlyingPrice: number;
  underlyingTimestamp: Date;
  expiry: string;
  quotes: HistoricalOptionQuote[];
  /** Lot size in force at `asOf` (lot sizes change over time). */
  lotSize: number;
  asOf: Date;
}

export interface HistoricalMarketDataProvider {
  readonly name: string;
  /** Expiries that were listed at `asOf` (not those listed later). */
  listedExpiries(underlying: string, asOf: Date): Promise<string[]>;
  /** Latest snapshot with every component time-stamped ≤ asOf. */
  chainAt(underlying: string, expiry: string, asOf: Date): Promise<HistoricalChainSnapshot>;
  /** Official settlement price for an expiry (known only after expiry). */
  settlementPrice(underlying: string, expiry: string): Promise<number>;
}

export class LookAheadError extends Error {}

export class PointInTimeGuard implements HistoricalMarketDataProvider {
  readonly name: string;
  constructor(private readonly inner: HistoricalMarketDataProvider, private readonly decisionTime: () => Date) {
    this.name = `pit(${inner.name})`;
  }

  async listedExpiries(underlying: string, asOf: Date): Promise<string[]> {
    this.check(asOf, 'listedExpiries asOf');
    return this.inner.listedExpiries(underlying, asOf);
  }

  async chainAt(underlying: string, expiry: string, asOf: Date): Promise<HistoricalChainSnapshot> {
    this.check(asOf, 'chainAt asOf');
    const s = await this.inner.chainAt(underlying, expiry, asOf);
    this.check(s.asOf, 'snapshot asOf');
    this.check(s.underlyingTimestamp, 'underlying timestamp');
    for (const q of s.quotes) this.check(q.timestamp, `quote ${q.symbol}`);
    return s;
  }

  async settlementPrice(underlying: string, expiry: string): Promise<number> {
    const t = this.decisionTime();
    const expiryClose = new Date(`${expiry}T10:00:00Z`); // 15:30 IST
    if (t < expiryClose) throw new LookAheadError(`Settlement of ${expiry} requested at ${t.toISOString()} (before expiry)`);
    return this.inner.settlementPrice(underlying, expiry);
  }

  private check(ts: Date, what: string): void {
    const t = this.decisionTime();
    if (ts.getTime() > t.getTime()) {
      throw new LookAheadError(`${what} ${ts.toISOString()} is after decision time ${t.toISOString()}`);
    }
  }
}
