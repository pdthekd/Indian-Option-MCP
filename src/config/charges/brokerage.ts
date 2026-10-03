/**
 * Versioned broker fee plans. Broker fees are configuration, not statute.
 */

import type { BrokeragePlan } from '../../costs/types.js';

export const BROKERAGE_PLANS: readonly BrokeragePlan[] = Object.freeze([
  {
    id: 'ZERODHA-FO-2024-10-01',
    broker: 'Zerodha',
    effectiveFrom: '2024-10-01',
    effectiveTo: null,
    options: { flatPerExecutedOrder: 20 },
    futures: { percentOfTurnover: 0.0003, capPerExecutedOrder: 20 },
    exercise: { flatPerContractSettlement: 0 },
    sources: [
      {
        description: 'Zerodha charges page: options flat ₹20/executed order; futures 0.03 % or ₹20, whichever lower',
        url: 'https://zerodha.com/charges',
        retrieved: '2026-10-03',
        verification: 'BROKER_PUBLISHED',
      },
    ],
    notes: [
      'Exercise/expiry settlement brokerage set to 0 — NOT verified. Override for conservative tests.',
      'Brokerage is charged per EXECUTED ORDER; one order filled in several trades counts once.',
    ],
  },
  {
    id: 'ZERO-BROKERAGE-TEST',
    broker: 'none',
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    options: { flatPerExecutedOrder: 0 },
    futures: { percentOfTurnover: 0, capPerExecutedOrder: 0 },
    exercise: { flatPerContractSettlement: 0 },
    sources: [],
    notes: ['For isolating statutory charges in tests only. Never use for strategy evaluation.'],
  },
]);
