/**
 * Versioned NSE equity-derivatives (F&O) charge schedules.
 *
 * NEVER edit a published schedule in place. When a rate changes, close the
 * current schedule (set `effectiveTo`) and add a new one. Every schedule must
 * list its sources and verification level. See docs/TRANSACTION_COST_MODEL.md.
 */

import type { ChargeSchedule } from '../../costs/types.js';

const ZERODHA_CHARGES = {
  description: 'Zerodha published charges page (Equity F&O, NSE)',
  url: 'https://zerodha.com/charges',
  retrieved: '2026-10-03',
  verification: 'BROKER_PUBLISHED' as const,
};

export const NSE_FO_SCHEDULES: readonly ChargeSchedule[] = Object.freeze([
  {
    id: 'IN-NSE-FO-2024-10-01',
    effectiveFrom: '2024-10-01',
    effectiveTo: '2026-03-31',
    exchange: 'NSE',
    options: {
      sttSellOnPremium: 0.001, // 0.10 % (Finance (No. 2) Act 2024)
      sttExerciseOnIntrinsic: 0.00125, // 0.125 %
      exchangeTxnOnPremium: 0.0003503, // 0.03503 %
      ipftOnPremium: 0.000005, // ₹50 per crore
      stampDutyBuy: 0.00003, // 0.003 %
    },
    futures: {
      sttSell: 0.0002, // 0.02 %
      exchangeTxn: 0.0000173, // 0.00173 %
      ipft: 0.000001, // ₹10 per crore
      stampDutyBuy: 0.00002, // 0.002 %
    },
    sebiFeePerCrore: 10,
    gstRate: 0.18,
    gstOn: ['brokerage', 'exchangeTxn', 'ipft', 'sebiFee'],
    sources: [
      {
        description: 'STT rates per Finance (No. 2) Act 2024, effective 2024-10-01 (secondary reporting)',
        url: 'https://cleartax.in/s/securities-transaction-tax-stt',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
      {
        description:
          'Exchange transaction + IPFT split inferred so that the sum equals the current broker-published combined ' +
          'figure (0.03553 % options / 0.00183 % futures). Historical exchange rates NOT independently verified.',
        url: 'https://zerodha.com/charges',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
    ],
    notes: [
      'For back-testing only. Exchange-charge history before 2026-04-01 is not verified against NSE circulars.',
    ],
  },
  {
    id: 'IN-NSE-FO-2026-04-01',
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    exchange: 'NSE',
    options: {
      sttSellOnPremium: 0.0015, // 0.15 % on sell-side premium
      sttExerciseOnIntrinsic: 0.0015, // 0.15 % of intrinsic value on exercise
      exchangeTxnOnPremium: 0.0003503,
      ipftOnPremium: 0.000005,
      stampDutyBuy: 0.00003,
    },
    futures: {
      sttSell: 0.0005, // 0.05 %
      exchangeTxn: 0.0000173,
      ipft: 0.000001,
      stampDutyBuy: 0.00002,
    },
    sebiFeePerCrore: 10,
    gstRate: 0.18,
    gstOn: ['brokerage', 'exchangeTxn', 'ipft', 'sebiFee'],
    sources: [
      ZERODHA_CHARGES,
      {
        description: 'Union Budget 2026: STT on futures 0.02→0.05 %, options premium 0.10→0.15 %, exercise 0.125→0.15 %, from 2026-04-01',
        url: 'https://www.icicidirect.com/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-need-to-know',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
    ],
    notes: [
      'Broker page shows NSE transaction charge 0.03553 % (options) and 0.00183 % (futures). These are modelled as ' +
        'exchange 0.03503 % + IPFT 0.0005 % and 0.00173 % + 0.0001 %; the split is an inference — the TOTAL matches.',
      'GST base assumed to include IPFT (broker page: "18 % on brokerage + SEBI charges + transaction charges").',
      'Must be verified against the Finance Act 2026 and current NSE circulars before any live use.',
    ],
  },
]);
