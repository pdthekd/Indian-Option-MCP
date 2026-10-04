#!/usr/bin/env node
/**
 * Experiment registry CLI.
 *
 *   node dist/experiments-cli.mjs verify   [--file research/experiments.jsonl]
 *   node dist/experiments-cli.mjs list     [--file ...]
 *   node dist/experiments-cli.mjs register <experiment.json> [--file ...]
 */

import { readFileSync } from 'node:fs';
import { appendExperiment, readRegistry, verifyRegistry, trialsFor } from '../research/experiment-registry.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const file = arg('file') ?? 'research/experiments.jsonl';
  const cmd = process.argv[2];
  if (cmd === 'register') {
    const e = appendExperiment(file, JSON.parse(readFileSync(process.argv[3], 'utf8')));
    console.log(`Registered ${e.id} as #${e.seq} (${e.hash.slice(0, 16)})`);
    return 0;
  }
  const entries = readRegistry(file);
  const errs = verifyRegistry(entries);
  if (cmd === 'list') {
    for (const e of entries) {
      console.log(`${e.id} #${e.seq} ${e.kind} ${e.strategy.id} v${e.strategy.version} [${e.costModel.brokeragePlanId}, ${e.executionModel.spreadModel}] net ${e.result?.netTotal ?? '-'} → ${e.decision}`);
    }
    const ids = [...new Set(entries.map((e) => e.strategy.id))];
    for (const id of ids) console.log(`Trials of ${id}: ${trialsFor(entries, id)}`);
  }
  if (errs.length) {
    console.error(`REGISTRY NOT INTACT (${errs.length}):`);
    errs.forEach((x) => console.error(`  ${x}`));
    return 2;
  }
  console.log(`Registry intact: ${entries.length} entries.`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
