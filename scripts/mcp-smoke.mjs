#!/usr/bin/env node
/**
 * MCP stdio smoke test against the BUILT bundle (dist/bundle.mjs).
 *
 * Uses only the locally installed, lockfile-pinned MCP SDK — no `npx`
 * downloads. Checks: startup, stdout purity (every stdout line must be a
 * JSON-RPC message), tool/resource/prompt registration, schema rejection,
 * fail-closed provider config.
 *
 *   node scripts/mcp-smoke.mjs          # offline checks only
 *   node scripts/mcp-smoke.mjs --live   # also calls NSE once (read-only)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(root, 'dist/bundle.mjs');
const live = process.argv.includes('--live');

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

function startServer(env = {}) {
  const child = spawn(process.execPath, [bundle], {
    // Minimal environment: do not leak the caller's env (e.g. broker tokens).
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const nonJson = [];
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { nonJson.push(line); continue; }
      if (msg.jsonrpc !== '2.0') nonJson.push(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const rpc = (method, params, timeoutMs = 60_000) => new Promise((res, rej) => {
    const myId = ++id;
    const t = setTimeout(() => { pending.delete(myId); rej(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(myId, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return { child, rpc, notify, nonJson, getStderr: () => stderr, exited };
}

async function init(s) {
  const r = await s.rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
  });
  s.notify('notifications/initialized', {});
  return r;
}

// 1. Normal start
{
  const s = startServer({ DATA_PROVIDER: 'nse' });
  const r = await init(s);
  check(r.result?.serverInfo?.name === 'indian-option-mcp', 'initialize handshake');
  const tools = (await s.rpc('tools/list', {})).result.tools;
  check(tools.length === 29, `29 tools registered (got ${tools.length})`);
  check(!tools.some((t) => /order|place|execute/i.test(t.name)), 'no order/execution tools exposed');
  check(tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), 'every tool has an object input schema');
  const res = (await s.rpc('resources/list', {})).result.resources;
  check(res.some((x) => x.uri === 'market://status'), 'resource market://status registered');
  const prompts = (await s.rpc('prompts/list', {})).result.prompts;
  check(prompts.length === 2, '2 prompts registered');

  const bad = [
    ['calculate_greeks', { spot: -100, strike: 100, expiry_days: 5, iv: 15, type: 'CE' }],
    ['calculate_greeks', { spot: 100, strike: 100, expiry_days: 5, iv: 15, type: 'XX' }],
    ['get_option_chain', { symbol: 'A'.repeat(1000) }],
    ['get_option_chain', { symbol: 'NIFTY', expiry: "2026-10-06'; DROP" }],
    ['custom_strategy', { symbol: 'NIFTY', legs: Array.from({ length: 50 }, () => ({ type: 'CE', strike: 1, action: 'BUY', qty: 1 })) }],
    ['position_sizing', { capital: 1e5, risk_percent: 2, max_loss_per_lot: 0 }],
  ];
  for (const [name, args] of bad) {
    const out = await s.rpc('tools/call', { name, arguments: args });
    const rejected = Boolean(out.error) || out.result?.isError === true;
    check(rejected, `schema rejects ${name} ${JSON.stringify(args).slice(0, 60)}`);
  }

  const g1 = await s.rpc('tools/call', { name: 'calculate_greeks', arguments: { spot: 24000, strike: 24000, expiry_days: 7, iv: 14, type: 'CE' } });
  const g2 = await s.rpc('tools/call', { name: 'calculate_greeks', arguments: { spot: 24000, strike: 24000, expiry_days: 7, iv: 14, type: 'CE' } });
  check(JSON.stringify(g1.result) === JSON.stringify(g2.result), 'pure tools are deterministic');

  const tc = await s.rpc('tools/call', { name: 'estimate_transaction_costs', arguments: { orders: [{ instrument: 'OPTION', side: 'SELL', quantity: 65, price: 100 }], trade_date: '2026-10-05' } });
  check(/STT 9\.75/.test(tc.result.content[0].text), 'cost tool: 0.15 % STT on ₹6,500 sell premium = ₹9.75');

  if (live) {
    console.log('… live NSE call (read-only, may take up to ~60 s)');
    const c = await s.rpc('tools/call', { name: 'get_option_chain', arguments: { symbol: 'NIFTY', strike_range: 2 } }, 120_000);
    const txt = c.result?.content?.[0]?.text ?? JSON.stringify(c.error ?? c.result);
    console.log(txt.split('\n').slice(0, 8).map((l) => '      | ' + l).join('\n'));
    check(c.result?.isError ? /unavailable|failed|HTTP|blocked/i.test(txt) : /DATA QUALITY: (FULL|DEGRADED|STALE|UNAVAILABLE)/.test(txt),
      'live chain: either a quality-labelled chain or an explicit error');
  }

  check(s.nonJson.length === 0, `stdout contains only JSON-RPC (${s.nonJson.length} stray lines)`);
  const se = s.getStderr();
  check(!/KITE_ACCESS_TOKEN=|Authorization: token [^[]/.test(se), 'stderr contains no credential material');
  s.child.kill();
}

// 2. Fail-closed configuration
{
  const s = startServer({ DATA_PROVIDER: 'zerodha' });
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('running'), 10_000))]);
  check(code !== 'running' && code !== 0, `DATA_PROVIDER=zerodha without credentials exits non-zero (got ${code})`);
  check(/Refusing to fall back/.test(s.getStderr()), 'fail-closed message on stderr');
  if (code === 'running') s.child.kill();
}
{
  const s = startServer({ DATA_PROVIDER: 'bogus' });
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('running'), 10_000))]);
  check(code !== 'running' && code !== 0, 'invalid DATA_PROVIDER exits non-zero');
  if (code === 'running') s.child.kill();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
