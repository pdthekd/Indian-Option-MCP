#!/usr/bin/env node
/**
 * Rebuild src/data/constants/lot-history.generated.ts from every stored NSE
 * F&O bhavcopy raw file (all instruments: index and stock options/futures).
 *
 *   node dist/derive-lot-sizes-cli.mjs [--out src/data/constants/lot-history.generated.ts]
 *
 * Run from the repository root after downloading bhavcopies.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from '../history/zip.js';
import { parseBhavcopyCsv } from '../history/bhavcopy.js';
import { dataDir } from '../history/paths.js';
import { deriveLotHistory, renderLotHistoryModule, type LotObservation } from '../history/lot-size-derivation.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const out = arg('out') ?? 'src/data/constants/lot-history.generated.ts';
  const raw = join(dataDir('bhavcopy/nse-fo'), 'raw');
  const files = readdirSync(raw).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv\.zip$/.test(f)).sort();
  if (files.length === 0) throw new Error(`No raw bhavcopy files in ${raw}`);

  const obs: LotObservation[] = [];
  for (const f of files) {
    const entries = readZip(readFileSync(join(raw, f)));
    const csv = entries.find((e) => e.name.toLowerCase().endsWith('.csv'));
    if (!csv) throw new Error(`${f}: no CSV inside`);
    for (const r of parseBhavcopyCsv(csv.data.toString('utf8'))) {
      if (r.lotSize !== null) obs.push({ tradeDate: r.tradeDate, symbol: r.symbol, lotSize: r.lotSize });
    }
  }
  const h = deriveLotHistory(obs);
  const note = `NSE F&O UDiFF bhavcopy (NewBrdLotQty), ${h.tradeDates} trade dates ${h.dataFrom} → ${h.dataTo}, all index and stock contracts`;
  writeFileSync(out, renderLotHistoryModule(h, note));

  const transitionDays = Object.values(h.transitions).reduce((a, t) => a + t.length, 0);
  console.error(`Read ${files.length} files, ${obs.length.toLocaleString()} contract rows.`);
  console.error(`Symbols: ${Object.keys(h.periods).length}; transition symbol-days: ${transitionDays}.`);
  console.error(`Wrote ${out}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
