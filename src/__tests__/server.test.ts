/**
 * MCP integration tests over an in-memory transport with a fake provider.
 * Hermetic: no network access.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { BaseProvider, type OptionChainData, type OptionData } from '../data/providers/base.provider.js';

const EXP = '2026-10-06';

function opt(strike: number, type: 'CE' | 'PE', ltp: number | null, iv: number | null): OptionData {
  return {
    strikePrice: strike, expiryDate: EXP, optionType: type, lastPrice: ltp, change: null, pChange: null,
    openInterest: 1000, changeinOpenInterest: 10, totalTradedVolume: 100, impliedVolatility: iv,
    bidQty: 75, bidPrice: ltp === null ? null : ltp - 0.5, askQty: 75, askPrice: ltp === null ? null : ltp + 0.5,
    underlyingValue: 25000,
  };
}

class FakeProvider extends BaseProvider {
  readonly name = 'fake';
  calls = 0;
  async initialize() { this._ready = true; }
  async getOptionChain(symbol: string, expiry?: string): Promise<OptionChainData> {
    this.calls++;
    if (expiry && expiry !== EXP) throw new Error(`Expiry ${expiry} is not listed by the source.`);
    const strikes = [24800, 24900, 25000, 25100, 25200];
    const rows = strikes.map((k) => ({
      strikePrice: k, expiryDate: EXP,
      CE: opt(k, 'CE', k === 25200 ? null : Math.max(1, 25000 - k + 100), 12),
      PE: opt(k, 'PE', Math.max(1, k - 25000 + 100), 13),
    }));
    return {
      symbol, underlyingValue: 25000, expiryDate: EXP, expiryDates: [EXP, '2026-10-13'], strikePrices: strikes, rows,
      timestamp: '05-Oct-2026 11:00:00',
      dataQuality: { status: 'FULL', source: 'nse-primary', unavailableFields: [], reasons: [], asOf: '2026-10-05T05:30:00.000Z', fetchedAt: '2026-10-05T05:30:01.000Z' },
      totalCEOpenInterest: 5000, totalPEOpenInterest: 5000, totalCEVolume: 500, totalPEVolume: 500,
    };
  }
  async getQuote(): Promise<never> { throw new Error('n/a'); }
  async getQuotes() { return new Map(); }
  async getExpiryDates() { return [EXP]; }
  async getSpotPrice() { return 25000; }
  async getHistoricalData() { return []; }
  async getInstruments() { return []; }
  async getMarketStatus() { return { market: 'x', status: 'Open' as const, timestamp: '' }; }
}

let client: Client;
const fake = new FakeProvider();

async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
  return { isError: Boolean(r.isError), text: t };
}

beforeAll(async () => {
  const server = createServer({
    provider: fake,
    eagerInit: false,
    now: () => new Date('2026-10-05T05:31:00Z'),
    marketOpen: () => true,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe('MCP server', () => {
  it('registers the expected tools, a resource and prompts; none can place orders', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names.length).toBe(29);
    expect(names).toContain('estimate_transaction_costs');
    expect(names).toContain('estimate_tax');
    expect(names.some((n) => /order|place|execute|buy|sell/i.test(n))).toBe(false);
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain('market://status');
    expect((await client.listPrompts()).prompts.length).toBe(2);
  });

  it('rejects malformed inputs at the schema boundary', async () => {
    for (const [name, args] of [
      ['calculate_greeks', { spot: -1, strike: 100, expiry_days: 5, iv: 15, type: 'CE' }],
      ['calculate_greeks', { spot: 100, strike: 100, expiry_days: 0, iv: 15, type: 'CE' }],
      ['calculate_greeks', { spot: 100, strike: 100, expiry_days: 5, iv: 0, type: 'CE' }],
      ['calculate_option_price', { spot: 1e309, strike: 100, expiry_days: 5, iv: 15, type: 'CE' }],
      ['get_option_chain', { symbol: 'NIFTY; rm -rf /' }],
      ['get_option_chain', { symbol: 'NIFTY', expiry: '../../etc' }],
      ['custom_strategy', { symbol: 'NIFTY', legs: [] }],
      ['position_sizing', { capital: 100000, risk_percent: 500, max_loss_per_lot: 100 }],
    ] as const) {
      const r = await call(name, args as Record<string, unknown>);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it('chain output carries a data-quality banner and is deterministic', async () => {
    const a = await call('get_option_chain', { symbol: 'NIFTY' });
    const b = await call('get_option_chain', { symbol: 'NIFTY' });
    expect(a.text).toContain('DATA QUALITY: FULL');
    expect(a.text).toContain('age 60s');
    expect(a.text).toBe(b.text);
  });

  it('build_strategy reports GROSS, costs and NET', async () => {
    const r = await call('build_strategy', { symbol: 'NIFTY', strategy_name: 'bull_call_spread', otm_offset: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('GROSS');
    expect(r.text).toContain('Round-trip charges');
    expect(r.text).toContain('NET (after estimated round-trip charges');
    expect(r.text).toContain('Lot size 65 for NIFTY contracts expiring 2026-10-06 [USER_PROVIDED]');
  });

  it('refuses to price a leg with no market price instead of using 0', async () => {
    const r = await call('custom_strategy', { symbol: 'NIFTY', legs: [{ type: 'CE', strike: 25200, action: 'BUY', qty: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No market price/);
  });

  it('naked short call is reported with unlimited loss', async () => {
    const r = await call('custom_strategy', { symbol: 'NIFTY', legs: [{ type: 'CE', strike: 25000, action: 'SELL', qty: 1 }] });
    expect(r.text).toMatch(/Max loss: -Unlimited/);
  });

  it('rejects unlisted expiries', async () => {
    const r = await call('get_option_chain', { symbol: 'NIFTY', expiry: '2026-10-20' });
    expect(r.isError).toBe(true);
  });

  it('calendar strategies are refused', async () => {
    const r = await call('build_strategy', { symbol: 'NIFTY', strategy_name: 'calendar_call_spread' });
    expect(r.isError).toBe(true);
  });

  it('estimate_tax output is labelled as an estimate', async () => {
    const r = await call('estimate_tax', { financial_year: 'FY2026-27', net_trading_pnl: 300000, other_taxable_income: 1200000 });
    expect(r.text).toMatch(/ESTIMATE ONLY/);
  });
});
