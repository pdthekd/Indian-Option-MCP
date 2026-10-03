/**
 * Versioned broker fee plans. Broker fees are configuration, not statute.
 */

import type { BrokeragePlan } from '../../costs/types.js';

export const BROKERAGE_PLANS: readonly BrokeragePlan[] = Object.freeze([
  {
    id: 'ZERODHA-FO-r2',
    broker: 'Zerodha',
    effectiveFrom: '2024-10-01',
    effectiveTo: null,
    options: { flatPerExecutedOrder: 20 },
    futures: { percentOfTurnover: 0.0003, capPerExecutedOrder: 20 },
    expirySettlement: { flatPerContract: 20, appliesTo: ['EXERCISED', 'ASSIGNED', 'EXPIRED_OTM'] },
    physicalDeliveryPctOfContractValue: 0.0025,
    dealerOrderFee: 50,
    sources: [
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
      'Expiry settlement brokerage modelled as ₹20 per settled contract position, including OTM expiry — the page lists ' +
        '"expired" contracts but does not state the amount. Conservative; confirm against a contract note.',
      'Brokerage is charged per EXECUTED ORDER; one order filled in several trades counts once.',
      'Dealer / auto square-off fee is available but not applied automatically (only when an order is flagged as dealer-placed).',
    ],
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
    sources: [],
    notes: ['For isolating statutory charges in tests only. Never use for strategy evaluation.'],
  },
]);

/** Plans withdrawn because they were wrong. Audit only. */
export const SUPERSEDED_BROKERAGE_PLANS: ReadonlyArray<{ id: string; supersededBy: string; reason: string }> = Object.freeze([
  {
    id: 'ZERODHA-FO-2024-10-01',
    supersededBy: 'ZERODHA-FO-r2',
    reason: 'Assumed ₹0 brokerage at expiry and none for assigned shorts; broker page says expired, exercised and assigned contracts are charged.',
  },
]);
