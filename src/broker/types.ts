/**
 * @module broker/types
 * Broker abstraction. Analytics code must NOT depend on this module; only the
 * execution engine talks to a BrokerAdapter.
 */

import type { CostBreakdown, InstrumentKind, Side } from '../costs/types.js';
import type { TradePnL } from '../pnl/pnl-engine.js';

export type BrokerMode = 'paper' | 'sandbox' | 'live';

export interface InstrumentSpec {
  /** Unique tradable symbol, e.g. "NIFTY26OCT25000CE". */
  symbol: string;
  kind: InstrumentKind;
  /** Settlement style: index options are cash-settled. */
  underlying: 'INDEX' | 'STOCK';
  lotSize: number;
  tickSize: number;
  expiry: string; // YYYY-MM-DD
  strike?: number;
  optionType?: 'CE' | 'PE';
  /** Underlying name, e.g. NIFTY (for hedge checks). */
  underlyingSymbol: string;
}

export interface Quote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  ltp: number | null;
  /** Exchange/source time of the quote. */
  timestamp: Date;
}

export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface OrderRequest {
  /** Caller-chosen idempotency key. Re-sending the same key returns the same order. */
  clientOrderId: string;
  symbol: string;
  side: Side;
  /** Units (must be a multiple of lot size). */
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  /** Decision price used to attribute slippage. */
  referencePrice?: number;
  strategyId?: string;
  strategyVersion?: string;
}

export interface Fill {
  fillId: string;
  orderId: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  referencePrice: number;
  timestamp: string;
  tradeDate: string;
  costs: CostBreakdown;
}

export interface Order extends OrderRequest {
  orderId: string;
  status: OrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  rejectReason?: string;
  fills: Fill[];
  createdAt: string;
  updatedAt: string;
}

export interface Position {
  symbol: string;
  /** Signed units: + long, − short. */
  quantity: number;
  averagePrice: number;
  realizedGrossPnL: number;
  chargesPaid: number;
  markPrice: number | null;
  grossUnrealizedPnL: number | null;
}

export interface AccountSnapshot {
  mode: BrokerMode;
  initialCapital: number;
  cash: number;
  marginBlocked: number;
  availableFunds: number;
  realizedGrossPnL: number;
  unrealizedGrossPnL: number;
  totalChargesPaid: number;
  /** realized + unrealized gross − all charges paid. */
  netPnL: number;
  /** Net P&L if everything were closed at marks, after ESTIMATED exit costs. */
  netLiquidationPnLEstimate: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  dayStartEquity: number;
  dailyNetPnL: number;
  weekStartEquity: number;
  weeklyNetPnL: number;
  closedTrades: TradePnL[];
  asOf: string;
}

export interface BrokerAdapter {
  readonly mode: BrokerMode;
  readonly name: string;
  isConnected(): boolean;
  getAccount(): Promise<AccountSnapshot>;
  getPositions(): Promise<Position[]>;
  getOrders(): Promise<Order[]>;
  getInstrument(symbol: string): Promise<InstrumentSpec>;
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(req: OrderRequest): Promise<Order>;
  modifyOrder(orderId: string, changes: { quantity?: number; limitPrice?: number }): Promise<Order>;
  cancelOrder(orderId: string): Promise<Order>;
}
