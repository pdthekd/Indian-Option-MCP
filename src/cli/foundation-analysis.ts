#!/usr/bin/env node
/**
 * Foundation-audit analyses of the frozen reference strategy: capital/margin, tail loss (with EOD
 * mark-to-market paths), regimes, and spread-calibration readiness from recorded quotes.
 *
 *   node dist/foundation-analysis-cli.mjs [--from 2024-10-01] [--to 2026-10-01] [--brokerage-plan ZERODHA-FO-r3]
 *
 * Writes <data dir>/backtests/foundation-analysis_<from>_<to>_<plan>.{json,md}. Read-only on data.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../history/paths.js';
import { loadBhavcopy, type BhavRecord } from '../history/bhavcopy.js';
import type { QuoteSnapshotRow } from '../history/quote-recorder.js';
import { runEodBacktest, EOD_PESSIMISTIC_V1, type BacktestTrade } from '../backtest/eod-engine.js';
import { midpoint } from '../backtest/report.js';
import { calculateOrderCosts, DEFAULT_BROKERAGE_PLAN } from '../costs/transaction-cost-engine.js';
import { tradeMargin, capitalSummary } from '../analytics/margin.js';
import { settlementOutcome, theoreticalMaxNetLoss, tailSummary, type TradeTail } from '../analytics/tail-loss.js';
import { labelTrade, bucketize, REGIME_THRESHOLDS, type RegimeTradeInput } from '../analytics/regime.js';
import { calibrate } from '../analytics/spread-calibration.js';
import { createRefIronCondor } from '../strategy/reference/nifty-weekly-iron-condor.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const inr = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function main(): void {
  const from = arg('from') ?? '2024-10-01';
  const to = arg('to') ?? '2026-10-01';
  const plan = arg('brokerage-plan') ?? DEFAULT_BROKERAGE_PLAN;
  const specialSessions = (arg('special-sessions') ?? 'exclude') === 'allow' ? 'ALLOW_FILLS' : 'NO_FILLS';
  const norm = join(dataDir('bhavcopy/nse-fo'), 'normalized');
  const allDates = readdirSync(norm).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();

  // Underlying series and expiry days over ALL stored dates (lookback before `from` is allowed: it is the past).
  const und: number[] = [];
  const undDates: string[] = [];
  const expiryDays = new Set<string>();
  const nifty = new Map<string, BhavRecord[]>();
  for (const d of allDates.filter((x) => x <= to)) {
    const rows = (loadBhavcopy(d) ?? []).filter((r) => r.symbol === 'NIFTY' && r.instrumentType === 'IDX_OPT');
    const s = rows.find((r) => r.underlyingPrice !== null)?.underlyingPrice;
    if (s) { und.push(s); undDates.push(d); }
    if (rows.some((r) => r.expiry === d)) expiryDays.add(d);
    if (d >= from) nifty.set(d, rows);
  }
  const isMonthly = (e: string) => ![...expiryDays].some((x) => x > e && x.slice(0, 7) === e.slice(0, 7));

  const result = runEodBacktest({
    strategy: createRefIronCondor(), tradeDates: allDates, load: (d) => nifty.get(d) ?? [],
    from, to, spread: EOD_PESSIMISTIC_V1, costOptions: { brokeragePlanId: plan }, specialSessions,
  });
  const dates = allDates.filter((d) => d >= result.from && d <= result.to);
  const S = (d: string) => und[undDates.indexOf(d)];

  // Capital
  const margins = result.trades.map((t) => tradeMargin(t, dates, S(t.entryDate)));
  const capital = capitalSummary(margins, dates, result.from, result.to);

  // Tail, with EOD mark-to-market between entry and expiry (exclusive)
  let missingMarks = 0;
  const tails: TradeTail[] = result.trades.map((t: BacktestTrade) => {
    const entryCharges = t.legs.reduce((a, l) => a + calculateOrderCosts(
      { instrument: 'OPTION', exchange: 'NSE', side: l.side, quantity: l.quantity, price: l.fillPrice, tradeDate: t.entryDate },
      { brokeragePlanId: plan }).totalCharges, 0);
    let worst: number | null = null;
    for (const d of dates.filter((x) => x > t.entryDate && x < t.expiry)) {
      const rows = nifty.get(d) ?? [];
      let mtm = -entryCharges, ok = true;
      for (const l of t.legs) {
        const row = rows.find((r) => r.expiry === t.expiry && r.optionType === l.type && r.strike === l.strike);
        if (!row || row.close === null) { ok = false; break; }
        mtm += (l.side === 'BUY' ? 1 : -1) * (row.close - l.fillPrice) * l.quantity;
      }
      if (!ok) { missingMarks++; continue; }
      worst = worst === null ? mtm : Math.min(worst, mtm);
    }
    const s0 = S(t.entryDate), s1 = S(t.expiry);
    return {
      tradeId: t.id, netPnL: t.pnl.netPnL, outcome: settlementOutcome(t),
      worstEodMtm: worst === null ? null : r2(Math.min(worst, t.pnl.netPnL)),
      theoreticalMaxNetLoss: theoreticalMaxNetLoss(t),
      underlyingMove: s0 && s1 ? r2(Math.abs(s1 / s0 - 1) * 10_000) / 10_000 : null,
    };
  });
  const tail = tailSummary(tails);

  // Regimes
  const split = midpoint(result.from, result.to);
  const rIn: RegimeTradeInput[] = result.trades.map((t) => ({
    tradeId: t.id, signalDate: t.signalDate, entryDate: t.entryDate, expiry: t.expiry, netPnL: t.pnl.netPnL,
    isMonthlyExpiry: isMonthly(t.expiry), period: t.entryDate < split ? 'DEVELOPMENT' : 'OUT_OF_SAMPLE',
  }));
  const labels = rIn.map((t) => labelTrade(t, undDates, und));
  const buckets = bucketize(rIn, labels);

  // Spread calibration readiness
  const qdir = dataDir('quotes/nse-fo');
  const quotes: QuoteSnapshotRow[] = [];
  for (const f of existsSync(qdir) ? readdirSync(qdir).filter((x) => /^\d{4}-\d{2}-\d{2}_.+\.jsonl$/.test(x)) : []) {
    for (const l of readFileSync(join(qdir, f), 'utf8').split('\n')) if (l.trim()) quotes.push(JSON.parse(l) as QuoteSnapshotRow);
  }
  const qSessions = [...new Set(quotes.map((q) => new Date(Date.parse(q.recordedAt) + 5.5 * 3_600_000).toISOString().slice(0, 10)))];
  const bigMove = qSessions.filter((d) => { const i = undDates.indexOf(d); return i > 0 && Math.abs(und[i] / und[i - 1] - 1) >= 0.01; }).length;
  const calib = calibrate(quotes, { expiryDaySessions: qSessions.filter((d) => expiryDays.has(d)).length, bigMoveSessions: bigMove });

  const out = { generated: new Date().toISOString(), from: result.from, to: result.to, brokeragePlanId: plan, spreadModel: result.spreadModel,
    trades: result.trades.length, capital, margins, tail, tails, regimeThresholds: REGIME_THRESHOLDS, regimes: buckets,
    labels: rIn.map((t, i) => ({ tradeId: t.tradeId, ...labels[i], netPnL: t.netPnL })), calibration: calib, missingMarks };
  const base = join(dataDir('backtests'), `foundation-analysis_${result.from}_${result.to}_${plan}${specialSessions === 'ALLOW_FILLS' ? '' : '_NO-SPECIAL-FILLS'}`);
  writeFileSync(`${base}.json`, JSON.stringify(out, null, 2));

  const md: string[] = [];
  md.push(`# Foundation analysis: ${result.strategyId} v${result.strategyVersion}`, '');
  md.push(`${result.from} → ${result.to}; ${result.trades.length} trades; brokerage ${plan}; spread ${result.spreadModel}; special sessions ${specialSessions}. All P&L NET.`, '');
  md.push('## Capital (SPAN_PROXY, unverified)', '', '| Metric | Value |', '|---|---:|');
  md.push(`| Max capital per trade | ${inr(capital.maxCapitalPerTrade)} |`, `| Mean capital per trade | ${inr(capital.meanCapitalPerTrade)} |`);
  md.push(`| Max concurrent positions | ${capital.maxConcurrentPositions} |`, `| Utilization (days blocked) | ${pct(capital.utilization)} |`);
  md.push(`| Max net drawdown | ${inr(capital.maxDrawdown)} |`, `| Sustaining capital (max blocked + max DD) | ${inr(capital.sustainingCapital)} |`);
  md.push(`| Total net | ${inr(capital.totalNet)} |`, `| Return on mean deployed | ${pct(capital.returnOnMeanDeployed)} |`);
  md.push(`| Return on sustaining capital (annualized) | ${pct(capital.annualizedOnSustainingCapital)} |`, '');
  md.push('## Tail loss', '', '| Metric | Value |', '|---|---:|');
  md.push(`| Sum of wins / losses | ${inr(tail.sumWins)} / ${inr(tail.sumLosses)} |`);
  md.push(`| Worst 5 trades' share of all losses | ${pct(tail.worst5ShareOfLosses)} |`, `| Worst 10 trades' share | ${pct(tail.worst10ShareOfLosses)} |`);
  md.push(`| VaR95 / ES95 (per trade loss) | ${inr(tail.var95)} / ${inr(tail.es95)} |`, `| VaR99 / ES99 | ${inr(tail.var99)} / ${inr(tail.es99)} |`);
  md.push(`| Average win / loss | ${inr(tail.averageWin)} / ${inr(tail.averageLoss)} |`, `| Average wins needed to repay the worst loss | ${tail.winsNeededToRepayWorst} |`);
  md.push(`| Max consecutive losses | ${tail.maxConsecutiveLosses} |`, `| Worst realized / theoretical max loss | ${pct(tail.realizedWorstVsTheoretical)} |`);
  md.push(`| Worst EOD open P&L | ${tail.worstEodMtm === null ? 'n/a' : inr(tail.worstEodMtm)} |`);
  md.push(`| Trades with EOD open P&L < −₹5,000 (recovered to a net win) | ${tail.tradesWithEodMtmBelowMinus5000} (${tail.recoveredFromEodMtmBelowMinus5000}) |`, '');
  md.push('| Outcome at expiry | Trades | Net |', '|---|---:|---:|');
  for (const [k, v] of Object.entries(tail.outcomes)) md.push(`| ${k} | ${v.count} | ${inr(v.net)} |`);
  md.push('', '| Worst trades | Net | Outcome |', '|---|---:|---|');
  for (const w of tail.worst) md.push(`| ${w.tradeId} | ${inr(w.netPnL)} | ${w.outcome} |`);
  md.push('', `Net excluding worst 1 / 5 / 10 trades: ${inr(tail.netExcludingWorst['1'])} / ${inr(tail.netExcludingWorst['5'])} / ${inr(tail.netExcludingWorst['10'])} (illustration only).`, '');
  md.push('## Regimes (thresholds pre-declared ' + REGIME_THRESHOLDS.declared + ')', '', '| Regime | Label | Trades | Net | Mean | Win rate | Worst | n ≥ 20 |', '|---|---|---:|---:|---:|---:|---:|---|');
  for (const b of buckets) md.push(`| ${b.regime} | ${b.label} | ${b.trades} | ${inr(b.net)} | ${inr(b.meanNet)} | ${pct(b.winRate)} | ${inr(b.worst)} | ${b.sufficient ? 'yes' : 'no'} |`);
  md.push('', '## Spread calibration readiness', '', `Sessions recorded: ${calib.sessions}; quotes in window: ${calib.quotesInWindow}. Ready: **${calib.ready ? 'YES' : 'NO'}**.`);
  for (const r of calib.reasonsNotReady) md.push(`- ${r}`);
  md.push('', `Mark-to-market days skipped for a missing leg close: ${missingMarks}.`);
  writeFileSync(`${base}.md`, md.join('\n') + '\n');
  console.error(`Wrote ${base}.md`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
