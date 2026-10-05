#!/usr/bin/env node
/**
 * READ-ONLY recorder health summary for the scheduled Claude checks (morning / close).
 *
 *   node dist/recorder-summary-cli.mjs --kind morning|close
 *
 * Prints one JSON object: current time, recorder status, last log lines, rows per symbol today,
 * median spread per symbol (close only) and a suggested verdict with the rules applied in code.
 * Reads files only; writes nothing, starts nothing. It exists so the scheduled checks can run a
 * single fixed command that a narrow permission rule allows.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const IST_MS = 5.5 * 3_600_000;
const dir = join(process.env.OPTIONS_HQ_DATA_DIR ?? join(homedir(), '.options-hq', 'data'), 'quotes', 'nse-fo');

interface Status {
  state?: string; istDate?: string; updatedAt?: string; lastWriteAt?: string | null; rowsToday?: number;
  consecutiveEmptyCycles?: number; lastError?: string | null; lastSkipReasons?: unknown[]; symbols?: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const istTime = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(11, 16);
const minutesAgo = (iso: string | null | undefined, now: number) => (iso ? (now - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100;
}

function main(): void {
  const kind = arg('kind') ?? 'morning';
  if (kind !== 'morning' && kind !== 'close') throw new Error('--kind must be morning or close');
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const today = new Date(now + IST_MS).toISOString().slice(0, 10);

  const statusPath = join(dir, 'status.json');
  const status: Status | null = existsSync(statusPath) ? (JSON.parse(readFileSync(statusPath, 'utf8')) as Status) : null;
  const logPath = join(dir, 'recorder.log');
  const logTail = existsSync(logPath) ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(kind === 'close' ? -20 : -15) : [];

  const rowsBySymbol: Record<string, number> = {};
  const medianSpread: Record<string, number> = {};
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.startsWith(`${today}_`) && x.endsWith('.jsonl')) : []) {
    const sym = f.slice(11, -6);
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim());
    rowsBySymbol[sym] = lines.length;
    if (kind === 'close') {
      const spreads: number[] = [];
      for (const l of lines) {
        const r = JSON.parse(l) as { bid: number | null; ask: number | null };
        if (typeof r.bid === 'number' && typeof r.ask === 'number' && r.bid > 0 && r.ask >= r.bid) spreads.push(r.ask - r.bid);
      }
      const m = median(spreads);
      if (m !== null) medianSpread[sym] = m;
    }
  }
  const totalRows = Object.values(rowsBySymbol).reduce((a, b) => a + b, 0);

  // Verdict rules (same as the scheduled-task instructions), applied deterministically.
  let verdict: 'OK' | 'HOLIDAY' | 'PROBLEM' = 'PROBLEM';
  let cause: string | null = null;
  const s = status;
  if (!s) cause = 'status.json missing';
  else if (s.istDate !== today) cause = `recorder did not start today (last run ${s.istDate ?? 'unknown'})`;
  else if (kind === 'morning') {
    if (s.state === 'RECORDING' && minutesAgo(s.updatedAt, now) <= 5 && minutesAgo(s.lastWriteAt, now) <= 10 && (s.consecutiveEmptyCycles ?? 0) < 5) verdict = 'OK';
    else if (s.state === 'IDLE_MARKET_CLOSED' && minutesAgo(s.updatedAt, now) <= 5) verdict = 'HOLIDAY';
    else if (minutesAgo(s.updatedAt, now) > 5) cause = `not updated since ${s.updatedAt ? istTime(s.updatedAt) : '?'} IST (stopped or PC asleep?)`;
    else if (s.state === 'ERROR' || s.state === 'STOPPED') cause = `recorder ${s.state}${s.lastError ? `: ${s.lastError}` : ''}`;
    else if ((s.consecutiveEmptyCycles ?? 0) >= 5) cause = `${s.consecutiveEmptyCycles} empty cycles in a row`;
    else cause = `no write since ${s.lastWriteAt ? istTime(s.lastWriteAt) : '?'} IST`;
  } else {
    const lastWriteIst = s.lastWriteAt ? istTime(s.lastWriteAt) : null;
    const idleLogged = logTail.some((l) => l.includes('market closed'));
    if (s.state === 'STOPPED' && !s.lastError && totalRows > 0 && lastWriteIst !== null && lastWriteIst >= '15:15') verdict = 'OK';
    else if (totalRows === 0 && idleLogged) verdict = 'HOLIDAY';
    else if (s.lastError) cause = `ended with error: ${s.lastError}`;
    else if (totalRows === 0) cause = 'no rows recorded today';
    else if (lastWriteIst !== null && lastWriteIst < '15:15') cause = `last write ${lastWriteIst} IST (stopped early)`;
    else cause = `state ${s.state ?? 'unknown'} at the end of the day`;
  }

  console.log(JSON.stringify({
    kind, checkedAt: nowIso, nowIst: istTime(nowIso), todayIst: today,
    recorderState: s?.state ?? null, statusIstDate: s?.istDate ?? null, updatedAt: s?.updatedAt ?? null,
    lastWriteAt: s?.lastWriteAt ?? null, lastWriteIst: s?.lastWriteAt ? istTime(s.lastWriteAt) : null,
    processRowsToday: s?.rowsToday ?? null, rowsBySymbol, totalRowsToday: totalRows,
    medianSpread: kind === 'close' ? medianSpread : undefined,
    consecutiveEmptyCycles: s?.consecutiveEmptyCycles ?? null, lastError: s?.lastError ?? null,
    lastSkipReasons: s?.lastSkipReasons ?? [], suggestedVerdict: verdict, cause, logTail,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err), suggestedVerdict: 'PROBLEM' }));
  process.exit(1);
}
