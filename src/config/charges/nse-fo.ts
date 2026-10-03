/**
 * Versioned NSE equity-derivatives (F&O) charge schedules.
 *
 * NEVER edit a published schedule in place. When a rate changes, close the
 * current schedule (set `effectiveTo`) and add a new one. When a schedule is
 * found to be WRONG, move it to SUPERSEDED_NSE_FO_SCHEDULES with the reason
 * and add a corrected revision (`-rN`). Every schedule must list its sources
 * and verification level. See docs/TRANSACTION_COST_MODEL.md.
 */

import type { ChargeSchedule } from '../../costs/types.js';

const ZERODHA_CHARGES = {
  description:
    'Zerodha charges page, Equity tab (F&O): transaction charges NSE 0.03553 % options (on premium) / 0.00183 % futures; ' +
    'IPFT footnote "Equity and Futures - ₹0.01 per crore + GST"',
  url: 'https://zerodha.com/charges/#tab-equities',
  retrieved: '2026-10-03',
  verification: 'BROKER_PUBLISHED' as const,
};

/** ₹0.01 per crore of turnover (NSE IPFT, equity & futures). */
const IPFT_FUTURES = 0.01 / 1e7;

export const NSE_FO_SCHEDULES: readonly ChargeSchedule[] = Object.freeze([
  {
    id: 'IN-NSE-FO-2024-10-01-r2',
    effectiveFrom: '2024-10-01',
    effectiveTo: '2026-03-31',
    exchange: 'NSE',
    options: {
      sttSellOnPremium: 0.001, // 0.10 % (Finance (No. 2) Act 2024)
      sttExerciseOnIntrinsic: 0.00125, // 0.125 %
      exchangeTxnOnPremium: 0.0003553, // assumed equal to current published rate
      ipftOnPremium: 0, // broker page lists IPFT for equity & futures only
      stampDutyBuy: 0.00003, // 0.003 %
    },
    futures: {
      sttSell: 0.0002, // 0.02 %
      exchangeTxn: 0.0000183, // assumed equal to current published rate
      ipft: IPFT_FUTURES,
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
        description: 'Exchange transaction charges before 2026-04-01 assumed equal to the 2026-10-03 published rates — NOT verified.',
        url: 'https://zerodha.com/charges/#tab-equities',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
    ],
    notes: [
      'For back-testing only. Exchange-charge history before 2026-04-01 is not verified against NSE circulars.',
    ],
  },
  {
    id: 'IN-NSE-FO-2026-04-01-r2',
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    exchange: 'NSE',
    options: {
      sttSellOnPremium: 0.0015, // 0.15 % on sell-side premium
      sttExerciseOnIntrinsic: 0.0015, // 0.15 % of intrinsic value, bought & exercised
      exchangeTxnOnPremium: 0.0003553, // 0.03553 % on premium (published)
      ipftOnPremium: 0, // not listed for options on the broker page
      stampDutyBuy: 0.00003, // 0.003 % buy side
    },
    futures: {
      sttSell: 0.0005, // 0.05 % sell side
      exchangeTxn: 0.0000183, // 0.00183 % (published)
      ipft: IPFT_FUTURES, // ₹0.01 / crore + GST
      stampDutyBuy: 0.00002, // 0.002 % buy side
    },
    sebiFeePerCrore: 10,
    gstRate: 0.18,
    gstOn: ['brokerage', 'exchangeTxn', 'ipft', 'sebiFee'],
    sources: [
      ZERODHA_CHARGES,
      {
        description: 'Union Budget 2026: STT on futures 0.02→0.05 %, options premium 0.10→0.15 %, exercise 0.125→0.15 %, from 2026-04-01 (effective date from secondary reporting)',
        url: 'https://www.icicidirect.com/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-need-to-know',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
    ],
    notes: [
      'Rates match the broker-published page (2026-10-03). Still to be reconciled against an actual contract note.',
      'GST applied to brokerage + SEBI + transaction charges + IPFT ("₹0.01 per crore + GST").',
    ],
  },
]);

/**
 * Schedules withdrawn because they were wrong. Kept for audit; never used for
 * cost lookup.
 */
export const SUPERSEDED_NSE_FO_SCHEDULES: ReadonlyArray<{ id: string; supersededBy: string; reason: string }> = Object.freeze([
  {
    id: 'IN-NSE-FO-2024-10-01',
    supersededBy: 'IN-NSE-FO-2024-10-01-r2',
    reason: 'Inferred split of the published transaction charge into exchange 0.03503 % + IPFT 0.0005 % (options) and 0.00173 % + 0.0001 % (futures) was wrong: IPFT is ₹0.01/crore on equity & futures only.',
  },
  {
    id: 'IN-NSE-FO-2026-04-01',
    supersededBy: 'IN-NSE-FO-2026-04-01-r2',
    reason: 'Same incorrect IPFT split. Totals were already equal to the published rates; only the attribution (and ₹0.01/crore futures IPFT) changes.',
  },
]);
