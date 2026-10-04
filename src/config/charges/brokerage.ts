/**
 * Versioned broker fee plans. Broker fees are configuration, not statute.
 */

import type { BrokeragePlan } from '../../costs/types.js';

export const BROKERAGE_PLANS: readonly BrokeragePlan[] = Object.freeze([
  {
    id: 'ZERODHA-FO-r3',
    broker: 'Zerodha',
    effectiveFrom: '2024-10-01',
    effectiveTo: null,
    options: { flatPerExecutedOrder: 20 },
    futures: { percentOfTurnover: 0.0003, capPerExecutedOrder: 20 },
    expirySettlement: { flatPerContract: 20, appliesTo: ['EXERCISED', 'ASSIGNED'] },
    physicalDeliveryPctOfContractValue: 0.0025,
    dealerOrderFee: 50,
    contractNote: { sttRounding: 'RUPEE_HALF_UP', stampDutyRounding: 'RUPEE_HALF_UP', gstSplit: 'CGST_SGST' },
    sources: [
      {
        description:
          'Zerodha support article "What happens if the option contract is not squared off on the expiry date?": index options ' +
          'expiring OTM/ATM are charged brokerage "only on one side ... not when they expire worthless"; ITM contracts settled on ' +
          'expiry are charged "brokerage on both sides". Read 2026-10-04.',
        url: 'https://support.zerodha.com/category/trading-and-markets/trading-faqs/f-otrading/articles/options-on-expiry-day',
        retrieved: '2026-10-04',
        verification: 'BROKER_PUBLISHED',
      },
      {
        description:
          'Reconciled against the account holder\'s own Zerodha F&O contract notes: 41 trading days (May–Aug 2025), ' +
          '310 NIFTY option trades. Brokerage ₹20 per EXECUTED ORDER (multi-fill orders charged once) matched on all 41 days; ' +
          'STT rounded to the paisa then to the whole rupee (half up) on each day\'s aggregate; stamp duty rounded to the ' +
          'rupee; exchange, SEBI and GST rounded to the paisa on the aggregate; GST shown as CGST 9 % + SGST 9 %; ' +
          'clearing charges ₹0. 40/41 days reproduced exactly; one day GST off by ₹0.02 (unexplained). ' +
          'No position was held to expiry, so expiry-settlement brokerage is NOT verified by these notes.',
        url: 'local: contract notes (not stored in repository)',
        retrieved: '2026-10-03',
        verification: 'CONTRACT_NOTE_RECONCILED',
      },
      {
        description:
          'Zerodha charges page: options flat ₹20/executed order; futures 0.03 % or ₹20 whichever lower; ' +
          '"Brokerage is also charged on expired, exercised, and assigned options contracts"; ' +
          '0.25 % of contract value where physical delivery happens; ₹50/order via dealer incl. auto square-off',
        url: 'https://zerodha.com/charges/#tab-equities',
        retrieved: '2026-10-03',
        verification: 'BROKER_PUBLISHED',
      },
    ],
    notes: [
      'Expiry settlement brokerage: ₹20 per ITM contract position exercised or assigned at expiry; none for OTM/ATM expiry ' +
        '(per the Zerodha support article). The ₹20 amount for exercised/assigned contracts is not yet seen on a contract note.',
      'Brokerage is charged per EXECUTED ORDER; one order filled in several trades counts once.',
      'Dealer / auto square-off fee is available but not applied automatically (only when an order is flagged as dealer-placed).',
    ],
  },
  {
    // SUPERSEDED by ZERODHA-FO-r3. Kept ONLY so results produced with it (e.g. the original
    // ref_nifty_weekly_iron_condor v1.0.0 run) can be reproduced exactly. Do not use for new work.
    id: 'ZERODHA-FO-r2',
    broker: 'Zerodha',
    effectiveFrom: '2024-10-01',
    effectiveTo: null,
    options: { flatPerExecutedOrder: 20 },
    futures: { percentOfTurnover: 0.0003, capPerExecutedOrder: 20 },
    expirySettlement: { flatPerContract: 20, appliesTo: ['EXERCISED', 'ASSIGNED', 'EXPIRED_OTM'] },
    physicalDeliveryPctOfContractValue: 0.0025,
    dealerOrderFee: 50,
    contractNote: { sttRounding: 'RUPEE_HALF_UP', stampDutyRounding: 'RUPEE_HALF_UP', gstSplit: 'CGST_SGST' },
    sources: [],
    notes: ['SUPERSEDED: charges settlement brokerage on OTM/ATM expiry, which Zerodha does not charge. Reproduction only.'],
  },
  {
    id: 'ZERO-BROKERAGE-TEST',
    broker: 'none',
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    options: { flatPerExecutedOrder: 0 },
    futures: { percentOfTurnover: 0, capPerExecutedOrder: 0 },
    expirySettlement: { flatPerContract: 0, appliesTo: [] },
    physicalDeliveryPctOfContractValue: 0,
    dealerOrderFee: 0,
    contractNote: { sttRounding: 'PAISA', stampDutyRounding: 'PAISA', gstSplit: 'IGST' },
    sources: [],
    notes: ['For isolating statutory charges in tests only. Never use for strategy evaluation.'],
  },
]);

/** Plans withdrawn because they were wrong. Audit only. */
export const SUPERSEDED_BROKERAGE_PLANS: ReadonlyArray<{ id: string; supersededBy: string; reason: string }> = Object.freeze([
  {
    id: 'ZERODHA-FO-r2',
    supersededBy: 'ZERODHA-FO-r3',
    reason: 'Charged ₹20 settlement brokerage on options expiring OTM/ATM. Zerodha\x27s support article states no brokerage is charged when options expire worthless; only ITM exercised/assigned contracts are charged. r2 overstated costs (~₹94 per fully-OTM iron condor).',
  },
  {
    id: 'ZERODHA-FO-2024-10-01',
    supersededBy: 'ZERODHA-FO-r2',
    reason: 'Assumed ₹0 brokerage at expiry and none for assigned shorts; broker page says expired, exercised and assigned contracts are charged.',
  },
]);
