/**
 * @module history/paths
 * Location of locally stored market data. Always OUTSIDE the repository so
 * downloaded or recorded data can never be committed.
 */

import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Root data directory: $OPTIONS_HQ_DATA_DIR or ~/.options-hq/data. */
export function dataRoot(env: Record<string, string | undefined> = process.env): string {
  const root = resolve(env.OPTIONS_HQ_DATA_DIR ?? join(homedir(), '.options-hq', 'data'));
  const repo = resolve(process.cwd());
  const rel = relative(repo, root);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`Data directory ${root} is inside the working directory ${repo}. Choose a location outside the repository.`);
  }
  return root;
}

/** Ensure and return a subdirectory of the data root. */
export function dataDir(sub: string, env?: Record<string, string | undefined>): string {
  if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(sub) || sub.includes('..')) throw new Error(`Invalid data subdirectory "${sub}"`);
  const dir = join(dataRoot(env), sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}
