/**
 * @module tax/tax-model
 *
 * SEPARATE layer from transaction costs. Statutory transaction charges (STT,
 * stamp duty, exchange/SEBI fees, GST) belong in NET trading P&L via the
 * TransactionCostEngine. Income tax is NOT a per-trade cost: it is estimated
 * here, on an annual basis, from aggregated net trading P&L.
 *
 * Output is an ESTIMATE, never tax advice or a confirmed liability.
 */

import { TAX_RULE_SETS, type TaxRuleSet } from '../config/tax/india.js';

export const TAX_ESTIMATE_LABEL =
  'ESTIMATE ONLY — not tax advice and not a confirmed tax liability. Depends on individual circumstances; consult a qualified tax professional.';

export function taxRulesFor(financialYear: string): TaxRuleSet {
  const r = TAX_RULE_SETS.find((x) => x.financialYear === financialYear);
  if (!r) {
    throw new Error(
      `No tax rule set for ${financialYear}. Available: ${TAX_RULE_SETS.map((x) => x.financialYear).join(', ')}`,
    );
  }
  return r;
}

/** Slab tax before rebate, surcharge and cess. */
function slabTax(income: number, rules: TaxRuleSet): number {
  let tax = 0;
  let lower = 0;
  for (const s of rules.slabs) {
    if (income <= lower) break;
    const taxable = Math.min(income, s.upTo) - lower;
    tax += taxable * s.rate;
    lower = s.upTo;
  }
  return tax;
}

/** Total income tax (incl. rebate, surcharge, cess) on a total income. */
export function incomeTax(totalIncome: number, rules: TaxRuleSet, residentIndividual: boolean): number {
  if (totalIncome <= 0) return 0;
  let tax = slabTax(totalIncome, rules);
  if (residentIndividual && totalIncome <= rules.rebate.maxTotalIncome) {
    tax = Math.max(0, tax - rules.rebate.maxRebate);
  } else if (residentIndividual && rules.rebate.marginalRelief && totalIncome > rules.rebate.maxTotalIncome) {
    // Marginal relief: tax may not exceed income above the rebate threshold.
    tax = Math.min(tax, totalIncome - rules.rebate.maxTotalIncome);
  }
  let surchargeRate = 0;
  for (const s of rules.surcharge) if (totalIncome > s.above) surchargeRate = s.rate;
  tax += tax * surchargeRate;
  tax += tax * rules.healthEducationCess;
  return Math.round(tax);
}

export interface TaxEstimateInput {
  financialYear: string;
  /** Aggregate NET trading P&L for the year (after ALL transaction costs). */
  netTradingPnL: number;
  /** Other business expenses attributable to trading (data feeds, software…), ₹. */
  otherTradingExpenses?: number;
  /** Other taxable income for the year (already net of its own deductions), ₹. */
  otherTaxableIncome?: number;
  residentIndividual: boolean;
}

export interface TaxEstimate {
  label: string;
  financialYear: string;
  ruleVersion: string;
  regime: string;
  treatment: string;
  grossTradingInputNote: string;
  estimatedTaxableTradingIncome: number;
  /** Loss carried forward (not set off) — positive number. */
  tradingLossNotSetOff: number;
  estimatedTotalIncome: number;
  estimatedTaxOnTotalIncome: number;
  estimatedTaxWithoutTrading: number;
  /** Incremental tax caused by the trading income. ESTIMATE. */
  estimatedTaxAttributableToTrading: number;
  /** netTradingPnL − otherTradingExpenses − attributable tax. ESTIMATE. */
  afterTaxTradingEstimate: number;
  assumptions: string[];
}

export function estimateTax(input: TaxEstimateInput): TaxEstimate {
  const rules = taxRulesFor(input.financialYear);
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${k} must be finite`);
  }
  const otherIncome = Math.max(0, input.otherTaxableIncome ?? 0);
  const tradingIncome = input.netTradingPnL - (input.otherTradingExpenses ?? 0);
  const taxableTrading = Math.max(0, tradingIncome);
  const lossNotSetOff = tradingIncome < 0 ? -tradingIncome : 0;
  const total = otherIncome + taxableTrading;
  const taxTotal = incomeTax(total, rules, input.residentIndividual);
  const taxWithout = incomeTax(otherIncome, rules, input.residentIndividual);
  const attributable = Math.max(0, taxTotal - taxWithout);
  return {
    label: TAX_ESTIMATE_LABEL,
    financialYear: rules.financialYear,
    ruleVersion: rules.ruleVersion,
    regime: rules.regime,
    treatment: rules.foTreatment,
    grossTradingInputNote: 'Input must be NET trading P&L (after all transaction costs), aggregated for the financial year.',
    estimatedTaxableTradingIncome: Math.round(taxableTrading),
    tradingLossNotSetOff: Math.round(lossNotSetOff),
    estimatedTotalIncome: Math.round(total),
    estimatedTaxOnTotalIncome: taxTotal,
    estimatedTaxWithoutTrading: taxWithout,
    estimatedTaxAttributableToTrading: attributable,
    afterTaxTradingEstimate: Math.round(tradingIncome - attributable),
    assumptions: [...rules.notes, ...rules.sources.map((s) => `Source (${s.verification}): ${s.description} — ${s.url}`)],
  };
}
