/**
 * @module backtest/report
 * Turns a BacktestResult into net-of-cost metrics, a chronological
 * development / out-of-sample split, cost sensitivity, and a readable
 * Markdown report. Gross figures are shown but never drive the verdict.
 */

import { computeNetMetrics, type NetMetrics } from '../analytics/performance.js';
import { costSensitivity, type SensitivityReport } from '../analytics/cost-sensitivity.js';
import type { BacktestResult } from './eod-engine.js';

export interface BacktestReport {
  result: BacktestResult;
  splitDate: string;
  all: NetMetrics;
  development: NetMetrics;
  outOfSample: NetMetrics;
  sensitivity: SensitivityReport;
  assumptions: string[];
}

/** Midpoint calendar date of the range — fixed by the range, not by results. */
export function midpoint(from: string, to: string): string {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  return new Date(a + Math.floor((b - a) / 2 / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

export function buildReport(result: BacktestResult, extraAssumptions: string[] = []): BacktestReport {
  const splitDate = midpoint(result.from, result.to);
  const pnl = result.trades.map((t) => t.pnl);
  const dev = result.trades.filter((t) => t.entryDate < splitDate).map((t) => t.pnl);
  const oos = result.trades.filter((t) => t.entryDate >= splitDate).map((t) => t.pnl);
  return {
    result,
    splitDate,
    all: computeNetMetrics(pnl),
    development: computeNetMetrics(dev),
    outOfSample: computeNetMetrics(oos),
    sensitivity: costSensitivity(pnl),
    assumptions: [
      'End-of-day data only (NSE bhavcopy): decisions on day D use D\'s published data; orders fill at the next trading day\'s close.',
      `No historical bid/ask: every fill pays the ${result.spreadModel} half-spread against the order (unverified until calibrated).`,
      'Held to expiry; settled at the exchange final settlement price from the expiry-day bhavcopy.',
      'Costs: versioned charge schedules and ZERODHA-FO-r2 brokerage, including expiry-settlement brokerage on every leg (conservative).',
      'Exact per-contract lot sizes from the fill day\'s bhavcopy. Fixed 1-lot size; no compounding.',
      'Margin, intraday risk, early assignment and gap behaviour inside the holding period are not modelled.',
      'Income tax is not deducted per trade (see the TaxModel for an annual estimate).',
      ...extraAssumptions,
    ],
  };
}

const inr = (x: number) => `${x < 0 ? '−' : ''}₹${Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function metricsTable(rows: Array<[string, NetMetrics]>): string {
  const head = '| Metric | ' + rows.map(([n]) => n).join(' | ') + ' |';
  const sep = '|---|' + rows.map(() => '---:').join('|') + '|';
  const line = (label: string, f: (m: NetMetrics) => string) => `| ${label} | ${rows.map(([, m]) => f(m)).join(' | ')} |`;
  return [
    head, sep,
    line('Trades', (m) => String(m.trades)),
    line('Gross P&L', (m) => inr(m.grossTotal)),
    line('Total costs (charges + spread)', (m) => inr(m.costsTotal)),
    line('**NET P&L**', (m) => `**${inr(m.netTotal)}**`),
    line('Net expectancy / trade', (m) => `${inr(m.netExpectancy)} (± ${Number.isFinite(m.netExpectancyStdErr) ? inr(m.netExpectancyStdErr) : 'n/a'})`),
    line('Gross expectancy / trade', (m) => inr(m.grossExpectancy)),
    line('Net win rate', (m) => pct(m.winRate)),
    line('Average net win / loss', (m) => `${inr(m.averageWin)} / ${inr(m.averageLoss)}`),
    line('Profit factor (net)', (m) => (Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞')),
    line('Max drawdown (net)', (m) => inr(m.maxDrawdown)),
    line('Longest losing streak', (m) => String(m.longestLosingStreak)),
    line('Costs as % of gross wins', (m) => (m.costsAsPctOfGrossProfit === null ? 'n/a' : `${m.costsAsPctOfGrossProfit.toFixed(0)}%`)),
    line('**Verdict**', (m) => `**${m.verdict}**`),
  ].join('\n');
}

export function renderMarkdown(rep: BacktestReport): string {
  const r = rep.result;
  const out: string[] = [];
  out.push(`# Backtest: ${r.strategyId} v${r.strategyVersion}`);
  out.push('');
  out.push(`Data: ${r.from} → ${r.to} (${r.tradeDatesUsed} trading days). Strategy fingerprint \`${r.strategyFingerprint.slice(0, 16)}\`. Spread model ${r.spreadModel}. Brokerage plan ${r.brokeragePlanId}.`);
  out.push(`Split: development = entries before ${rep.splitDate}; out-of-sample = from ${rep.splitDate}. Parameters were fixed before running; nothing was tuned.`);
  out.push('');
  out.push(`**Overall verdict: ${rep.all.verdict}.** ${rep.all.verdictReason}`);
  out.push('');
  out.push(metricsTable([['All', rep.all], ['Development', rep.development], ['Out-of-sample', rep.outOfSample]]));
  out.push('');
  out.push('## Cost sensitivity (all trades)');
  out.push('');
  out.push('| Scenario | Net P&L | Net expectancy / trade | Verdict |');
  out.push('|---|---:|---:|---|');
  for (const s of rep.sensitivity.scenarios) out.push(`| ${s.scenario.name} | ${inr(s.metrics.netTotal)} | ${inr(s.metrics.netExpectancy)} | ${s.metrics.verdict} |`);
  const be = rep.sensitivity.breakEven;
  out.push('');
  out.push(`Break-even: average costs per trade ${inr(be.breakEvenGrossPerTrade)} vs average gross per trade ${inr(be.breakEvenCostPerTrade)}; ` +
    `extra slippage the strategy could absorb per trade: ${inr(be.breakEvenExtraSlippagePerTrade)}; ` +
    `break-even win rate at observed net win/loss sizes: ${be.breakEvenWinRate === null ? 'n/a' : pct(be.breakEvenWinRate)}.`);
  out.push(`Survives all cost scenarios: **${rep.sensitivity.survivesAllScenarios ? 'YES' : 'NO'}**.`);
  out.push('');
  out.push('## Assumptions and limits');
  out.push('');
  for (const a of rep.assumptions) out.push(`- ${a}`);
  out.push('');
  out.push(`## Skipped signals (${r.skipped.length})`);
  out.push('');
  for (const s of r.skipped) out.push(`- ${s.signalDate}: ${s.reason}`);
  out.push('');
  out.push(`## Trades (${r.trades.length})`);
  out.push('');
  out.push('| Entry | Expiry | Legs (strike type side @fill) | Settle | Gross | Costs | Net |');
  out.push('|---|---|---|---:|---:|---:|---:|');
  for (const t of r.trades) {
    const legs = t.legs.map((l) => `${l.strike}${l.type} ${l.side === 'BUY' ? 'B' : 'S'}@${l.fillPrice}`).join(', ');
    out.push(`| ${t.entryDate} | ${t.expiry} | ${legs} | ${t.settlementPrice} | ${inr(t.pnl.grossPnL)} | ${inr(t.pnl.totalCosts)} | ${inr(t.pnl.netPnL)} |`);
  }
  out.push('');
  out.push('_Analysis only. Past results under these assumptions are not evidence of future returns._');
  return out.join('\n');
}
