/**
 * Versioned Indian income-tax assumptions for estimating tax on F&O income.
 *
 * ESTIMATES ONLY. These parameters change with every Finance Act and depend on
 * the individual's circumstances. Never edit a published version in place —
 * add a new one. See docs/TAX_MODEL.md.
 */

import type { SourceRef } from '../../costs/types.js';

export interface TaxSlab {
  /** Upper bound of the slab in ₹ (Infinity for the last slab). */
  upTo: number;
  rate: number;
}

export interface TaxRuleSet {
  ruleVersion: string;
  /** e.g. "FY2026-27" (tax year 1 Apr 2026 – 31 Mar 2027). */
  financialYear: string;
  regime: 'NEW';
  /** Treatment assumed for F&O income. */
  foTreatment: 'NON_SPECULATIVE_BUSINESS_INCOME';
  slabs: TaxSlab[];
  rebate: { residentIndividualsOnly: true; maxTotalIncome: number; maxRebate: number; marginalRelief: boolean };
  /** Surcharge thresholds on total income (marginal relief NOT modelled → overstates tax near thresholds). */
  surcharge: Array<{ above: number; rate: number }>;
  healthEducationCess: number;
  sources: SourceRef[];
  notes: string[];
}

const NEW_REGIME_SLABS: TaxSlab[] = [
  { upTo: 400_000, rate: 0 },
  { upTo: 800_000, rate: 0.05 },
  { upTo: 1_200_000, rate: 0.10 },
  { upTo: 1_600_000, rate: 0.15 },
  { upTo: 2_000_000, rate: 0.20 },
  { upTo: 2_400_000, rate: 0.25 },
  { upTo: Infinity, rate: 0.30 },
];

const COMMON = {
  regime: 'NEW' as const,
  foTreatment: 'NON_SPECULATIVE_BUSINESS_INCOME' as const,
  slabs: NEW_REGIME_SLABS,
  rebate: { residentIndividualsOnly: true as const, maxTotalIncome: 1_200_000, maxRebate: 60_000, marginalRelief: true },
  surcharge: [
    { above: 5_000_000, rate: 0.10 },
    { above: 10_000_000, rate: 0.15 },
    { above: 20_000_000, rate: 0.25 },
  ],
  healthEducationCess: 0.04,
  notes: [
    'F&O trading assumed to be non-speculative business income taxed at slab rates.',
    'STT, brokerage and other transaction charges assumed deductible as business expenses (they are already removed in NET trading P&L).',
    'Loss set-off rules (no set-off against salary; 8-year carry-forward) are NOT applied — a trading loss yields zero attributable tax, not a refund.',
    'Surcharge marginal relief, advance-tax interest, tax-audit costs, presumptive taxation and old regime are NOT modelled.',
    'Standard deduction (salary only) is not applied to business income.',
  ],
};

export const TAX_RULE_SETS: readonly TaxRuleSet[] = Object.freeze([
  {
    ...COMMON,
    ruleVersion: 'IN-NEW-REGIME-FY2025-26-v1',
    financialYear: 'FY2025-26',
    sources: [
      {
        description: 'Slabs, ₹60,000 rebate up to ₹12 lakh — Union Budget 2025 (secondary summary)',
        url: 'https://cleartax.in/s/income-tax-slabs',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
    ],
  },
  {
    ...COMMON,
    ruleVersion: 'IN-NEW-REGIME-FY2026-27-v1',
    financialYear: 'FY2026-27',
    sources: [
      {
        description: 'Budget 2026 left new-regime slabs and 87A rebate unchanged (secondary summary)',
        url: 'https://ndtvmoney.bankbazaar.com/tax/income-tax-slabs.html',
        retrieved: '2026-10-03',
        verification: 'UNVERIFIED',
      },
    ],
    notes: [
      ...COMMON.notes,
      'From 1 Apr 2026 the Income-tax Act, 2025 replaces the 1961 Act; section numbers differ. Not verified against the statute text.',
    ],
  },
]);
