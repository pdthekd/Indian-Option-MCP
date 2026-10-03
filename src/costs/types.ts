/**
 * @module costs/types
 * Types for the transaction-cost layer. All monetary values are INR.
 * All rates are FRACTIONS (0.0015 = 0.15 %), never percentages.
 */

export type InstrumentKind = 'OPTION' | 'FUTURE';
export type Side = 'BUY' | 'SELL';
export type Exchange = 'NSE';

export type VerificationLevel =
  /** Read from the exchange / regulator / statute itself. */
  | 'OFFICIAL'
  /** Model reproduced the user's actual broker contract notes (see the source description for scope). */
  | 'CONTRACT_NOTE_RECONCILED'
  /** Read from a broker's published charges page; not cross-checked with the primary source. */
  | 'BROKER_PUBLISHED'
  /** Derived, inferred or from secondary sources — must be verified before live use. */
  | 'UNVERIFIED';

export interface SourceRef {
  description: string;
  url: string;
  retrieved: string; // YYYY-MM-DD
  verification: VerificationLevel;
}

/** Statutory + exchange charges for one exchange segment, versioned by date. */
export interface ChargeSchedule {
  id: string;
  /** First trade date (inclusive, IST calendar date) this schedule applies to. */
  effectiveFrom: string;
  /** Last trade date (inclusive), or null if open-ended. */
  effectiveTo: string | null;
  exchange: Exchange;
  options: {
    /** STT on SELL side, on premium turnover. */
    sttSellOnPremium: number;
    /** STT paid by the holder on exercise, on intrinsic value (settlement − strike) × qty. */
    sttExerciseOnIntrinsic: number;
    /** Exchange transaction charge on premium turnover (both sides). */
    exchangeTxnOnPremium: number;
    /** Investor Protection Fund Trust charge on premium turnover, if billed separately. */
    ipftOnPremium: number;
    /** Stamp duty on BUY side premium turnover. */
    stampDutyBuy: number;
  };
  futures: {
    sttSell: number;
    exchangeTxn: number;
    ipft: number;
    stampDutyBuy: number;
  };
  /** SEBI turnover fee, ₹ per crore (1e7) of turnover, both sides. */
  sebiFeePerCrore: number;
  /** GST rate applied to the components listed in `gstOn`. */
  gstRate: number;
  gstOn: Array<'brokerage' | 'exchangeTxn' | 'ipft' | 'sebiFee'>;
  sources: SourceRef[];
  notes: string[];
}

/** Broker fee plan, versioned independently of statutory charges. */
export interface BrokeragePlan {
  id: string;
  broker: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  options: { flatPerExecutedOrder: number };
  futures: { percentOfTurnover: number; capPerExecutedOrder: number };
  /** Brokerage on option positions settled by the exchange at expiry. */
  expirySettlement: {
    /** ₹ per settled contract position (one symbol), cash-settled index options. */
    flatPerContract: number;
    /** Which settlement outcomes attract it. */
    appliesTo: Array<'EXERCISED' | 'ASSIGNED' | 'EXPIRED_OTM'>;
  };
  /** Brokerage as a fraction of contract value when physical delivery happens (stock F&O). */
  physicalDeliveryPctOfContractValue: number;
  /** Extra fee per order placed via dealer, incl. broker auto square-off (₹, + GST). */
  dealerOrderFee: number;
  /**
   * How the broker aggregates and rounds charges on a contract note (one note
   * per trade date per segment). Used by calculateContractNoteCosts.
   */
  contractNote: {
    sttRounding: 'RUPEE_HALF_UP' | 'PAISA';
    stampDutyRounding: 'RUPEE_HALF_UP' | 'PAISA';
    /** Exchange, SEBI and GST are rounded to the paisa on the day's aggregate. */
    gstSplit: 'CGST_SGST' | 'IGST';
  };
  sources: SourceRef[];
  notes: string[];
}

/** How adverse execution vs. the decision/reference price is modelled. */
export type SlippageModel =
  | { kind: 'NONE' }
  /** Fixed number of ticks against the order. */
  | { kind: 'TICKS'; ticks: number; tickSize: number }
  /** Basis points of price against the order. */
  | { kind: 'BPS'; bps: number }
  /** Fraction of the quoted bid-ask spread against the order (0.5 = cross half the spread). */
  | { kind: 'SPREAD_FRACTION'; fraction: number; bid: number; ask: number };

/** One executed (or simulated) order for cost calculation. */
export interface OrderForCosts {
  instrument: InstrumentKind;
  exchange: Exchange;
  side: Side;
  /** Units (shares / index units), i.e. lots × lot size. */
  quantity: number;
  /** Executed price per unit (option premium or futures price). */
  price: number;
  /** IST trade date YYYY-MM-DD — selects the schedule version. */
  tradeDate: string;
  /** Number of executed orders this fill represents for brokerage (default 1). */
  executedOrders?: number;
  /** Placed via broker dealer desk or broker auto square-off → dealer fee + GST applies. */
  dealerPlaced?: boolean;
}

export interface CostBreakdown {
  turnover: number;
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  ipft: number;
  sebiFee: number;
  stampDuty: number;
  gst: number;
  /** Execution shortfall vs reference price (positive = cost). */
  slippage: number;
  /** Any other modelled charge (currently 0). */
  otherCharges: number;
  /** Statutory + exchange + broker charges (excludes slippage). */
  totalCharges: number;
  /** totalCharges + slippage. */
  totalCost: number;
  scheduleId: string;
  brokeragePlanId: string;
  assumptions: string[];
}
