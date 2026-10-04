/**
 * Reconcile the cost model against broker contract notes.
 *
 * Input is a normalized, PII-free contract note (schema 'contract-note/v1'): trade date, fills and
 * the charges the broker reported. Produce it with scripts/contract_note_xlsx_to_json.py, which
 * drops names, addresses, PAN and client codes and hashes order numbers. Contract notes and their
 * JSON stay OUTSIDE the repository; only aggregate results may be written into docs.
 */

import { z } from 'zod';
import { calculateContractNoteCosts, type CostOptions } from './transaction-cost-engine.js';

export const ContractNoteSchema = z.object({
  schema: z.literal('contract-note/v1'),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  segment: z.literal('NSE-FO'),
  fills: z.array(z.object({
    orderId: z.string().min(1),
    instrument: z.enum(['OPTION', 'FUTURE']),
    side: z.enum(['BUY', 'SELL']),
    quantity: z.number().positive(),
    price: z.number().nonnegative(),
  })).min(1),
  reported: z.object({
    brokerage: z.number(),
    exchangeTxn: z.number(),
    clearing: z.number().default(0),
    stt: z.number(),
    sebiFee: z.number(),
    stampDuty: z.number(),
    gst: z.number(),
  }),
});
export type ContractNote = z.infer<typeof ContractNoteSchema>;

export const COMPONENTS = ['brokerage', 'exchangeTxn', 'stt', 'sebiFee', 'stampDuty', 'gst'] as const;
export type Component = (typeof COMPONENTS)[number];

export interface NoteReconciliation {
  tradeDate: string;
  fills: number;
  orders: number;
  model: Record<Component | 'total', number>;
  reported: Record<Component | 'total', number>;
  /** model − reported, per component (₹). */
  diff: Record<Component | 'total', number>;
  exact: boolean;
}

export interface ReconciliationSummary {
  notes: number;
  exactNotes: number;
  modelTotal: number;
  reportedTotal: number;
  diffTotal: number;
  maxAbsDailyDiff: number;
  componentMismatches: Record<Component, number>;
  /** PASS: every note within ₹0.05 total and aggregate within ₹1. */
  verdict: 'PASS' | 'FAIL';
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function reconcileNote(raw: unknown, opts: CostOptions = {}): NoteReconciliation {
  const note = ContractNoteSchema.parse(raw);
  const m = calculateContractNoteCosts(note.fills, note.tradeDate, opts);
  const model = { brokerage: m.brokerage, exchangeTxn: r2(m.exchangeTxn + m.ipft), stt: m.stt, sebiFee: m.sebiFee, stampDuty: m.stampDuty, gst: m.gst, total: 0 };
  model.total = r2(COMPONENTS.reduce((a, k) => a + model[k], 0));
  const rep = { ...note.reported, total: 0 };
  const reported = { brokerage: rep.brokerage, exchangeTxn: r2(rep.exchangeTxn + rep.clearing), stt: rep.stt, sebiFee: rep.sebiFee, stampDuty: rep.stampDuty, gst: rep.gst, total: 0 };
  reported.total = r2(COMPONENTS.reduce((a, k) => a + reported[k], 0));
  const diff = Object.fromEntries([...COMPONENTS, 'total'].map((k) => [k, r2(model[k as Component] - reported[k as Component])])) as NoteReconciliation['diff'];
  diff.total = r2(model.total - reported.total);
  return {
    tradeDate: note.tradeDate,
    fills: note.fills.length,
    orders: new Set(note.fills.map((f) => f.orderId)).size,
    model, reported, diff,
    exact: COMPONENTS.every((k) => diff[k] === 0),
  };
}

export function summarize(rows: readonly NoteReconciliation[]): ReconciliationSummary {
  const componentMismatches = Object.fromEntries(COMPONENTS.map((k) => [k, rows.filter((r) => r.diff[k] !== 0).length])) as Record<Component, number>;
  const modelTotal = r2(rows.reduce((a, r) => a + r.model.total, 0));
  const reportedTotal = r2(rows.reduce((a, r) => a + r.reported.total, 0));
  const maxAbs = rows.reduce((a, r) => Math.max(a, Math.abs(r.diff.total)), 0);
  return {
    notes: rows.length,
    exactNotes: rows.filter((r) => r.exact).length,
    modelTotal,
    reportedTotal,
    diffTotal: r2(modelTotal - reportedTotal),
    maxAbsDailyDiff: r2(maxAbs),
    componentMismatches,
    verdict: rows.length > 0 && maxAbs <= 0.05 && Math.abs(modelTotal - reportedTotal) <= 1 ? 'PASS' : 'FAIL',
  };
}
