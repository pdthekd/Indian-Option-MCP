/**
 * @module server
 * MCP Server setup — registers analytics-only tools, one resource and prompts.
 *
 * This server has NO order-placement capability. All outputs are analysis.
 * Every money figure is labelled GROSS or NET; NET figures include modelled
 * transaction costs from the TransactionCostEngine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { createDataProvider } from './data/provider-factory.js';
import { MemoryCache } from './data/cache/memory-cache.js';
import type { DataProvider, OptionChainData, OptionChainRow, DataQuality } from './data/providers/base.provider.js';
import { assessFreshness, qualityBanner, fmt } from './data/quality.js';

// Engine imports
import { optionPrice, calculateGreeks } from './engine/black-scholes.js';
import { calculateIV } from './engine/implied-volatility.js';
import { calculatePayoffAtExpiry, analyzeExpiryPayoff, type StrategyLeg as PayoffLeg } from './engine/payoff.js';
import { calculateMaxPain } from './engine/max-pain.js';
import { calculatePCR } from './engine/pcr.js';
import { analyzeOIDistribution } from './engine/oi-analysis.js';
import { calculateIVSmile, calculateIVSkew, expectedMove } from './engine/iv-surface.js';
import { STRATEGIES, MULTI_EXPIRY_STRATEGIES, buildStrategy, suggestStrategies, listStrategies } from './engine/strategy-builder.js';
import { estimateMargin } from './engine/margin-calculator.js';
import { probabilityOfProfitFromLegs, optimalPositionSize } from './engine/risk-metrics.js';

// Costs / P&L / tax
import { calculateOrderCosts, sumCosts, DEFAULT_BROKERAGE_PLAN } from './costs/transaction-cost-engine.js';
import type { CostBreakdown } from './costs/types.js';
import { estimateTax, TAX_ESTIMATE_LABEL } from './tax/tax-model.js';

// Constants & utils
import { getLotSize } from './data/constants/lot-sizes.js';
import { getNextExpiry, EXPIRY_RULES_NOTE } from './data/constants/expiry-calendar.js';
import { isMarketOpen, getMarketStatusInfo } from './utils/date.js';
import { calendarDaysToExpiry, istDate } from './utils/time.js';
import { formatCurrency, formatNumber, formatPercent, formatLargeNumber, formatOI } from './utils/format.js';

// ════════════════════════════════════════════════════════════
// Input schemas — every numeric input is finite and bounded
// ════════════════════════════════════════════════════════════

const Symbol = z.string().trim().min(1).max(32)
  .regex(/^[A-Za-z0-9&_\- ]+$/, 'symbol may contain letters, digits, space, &, _ and - only')
  .describe('Underlying symbol, e.g. NIFTY, BANKNIFTY, RELIANCE');
const Expiry = z.string().trim().max(20).regex(/^(\d{4}-\d{2}-\d{2}|\d{1,2}-[A-Za-z]{3}-\d{4})$/, 'expiry must be YYYY-MM-DD or DD-Mon-YYYY')
  .describe('Expiry date (YYYY-MM-DD or DD-Mon-YYYY). Defaults to the nearest listed expiry.');
const Price = z.number().finite().positive().max(10_000_000);
const Premium = z.number().finite().min(0).max(10_000_000);
const IvPct = z.number().finite().positive().max(500).describe('Implied volatility in percent, e.g. 15 for 15%');
const Days = z.number().finite().positive().max(3650).describe('Calendar days to expiry (fractional allowed, > 0)');
const RatePct = z.number().finite().min(0).max(50).describe('Risk-free rate in percent (default 7)');
const Lots = z.number().int().min(1).max(100);
const LotSize = z.number().int().positive().max(100_000);
const OptionLeg = z.object({
  type: z.enum(['CE', 'PE']),
  strike: Price,
  action: z.enum(['BUY', 'SELL']),
  qty: Lots.default(1).describe('Number of lots'),
});
const PricedLeg = OptionLeg.extend({ premium: Premium.describe('Premium per unit (₹)') });

const ANALYTICS_FOOTER =
  'Analytics only — no orders are placed. Not investment advice. GROSS figures exclude costs; NET figures include modelled costs (see docs/TRANSACTION_COST_MODEL.md).';

export interface ServerOptions {
  /** Inject a provider (tests). Defaults to the configured provider. */
  provider?: DataProvider;
  /** Start provider initialisation immediately (default true). */
  eagerInit?: boolean;
  /** Clock override (tests). */
  now?: () => Date;
  /** Market-open override (tests). */
  marketOpen?: () => boolean;
}

type Quality = DataQuality & { ageSeconds: number | null };

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function rupees(x: number): string {
  if (x === Infinity) return 'Unlimited';
  if (x === -Infinity) return '-Unlimited';
  return formatCurrency(x);
}

function atmRow(chain: OptionChainData): OptionChainRow {
  if (chain.rows.length === 0) throw new Error(`No option rows for ${chain.symbol} ${chain.expiryDate}.`);
  return chain.rows.reduce((best, r) =>
    Math.abs(r.strikePrice - chain.underlyingValue) < Math.abs(best.strikePrice - chain.underlyingValue) ? r : best,
  );
}

/** Strike interval inferred from the listed strikes around ATM (not a hard-coded table). */
function inferStrikeInterval(chain: OptionChainData): number {
  const strikes = chain.strikePrices;
  if (strikes.length < 2) throw new Error('Cannot infer strike interval: fewer than two strikes listed.');
  const atm = atmRow(chain).strikePrice;
  const idx = strikes.indexOf(atm);
  const near = strikes.slice(Math.max(0, idx - 3), idx + 4);
  const diffs = near.slice(1).map((s, i) => s - near[i]).filter((d) => d > 0);
  return Math.min(...diffs);
}

/** Lot size from the static table, with its verification status. */
function lotSizeInfo(symbol: string): { lotSize: number; note: string } {
  return {
    lotSize: getLotSize(symbol),
    note: 'Lot size from STATIC TABLE (UNVERIFIED — NSE revises lot sizes; verify against the exchange/broker instrument master).',
  };
}

/** Entry + exit (square-off at the same premium) cost estimate for option legs. */
function roundTripCosts(
  legs: Array<{ action: 'BUY' | 'SELL'; qty: number; premium: number }>,
  lotSize: number,
  tradeDate: string,
): { entry: ReturnType<typeof sumCosts>; exit: ReturnType<typeof sumCosts>; total: number } {
  const entry: CostBreakdown[] = [];
  const exit: CostBreakdown[] = [];
  for (const l of legs) {
    const q = l.qty * lotSize;
    entry.push(calculateOrderCosts({ instrument: 'OPTION', exchange: 'NSE', side: l.action, quantity: q, price: l.premium, tradeDate }));
    exit.push(calculateOrderCosts({
      instrument: 'OPTION', exchange: 'NSE', side: l.action === 'BUY' ? 'SELL' : 'BUY', quantity: q, price: l.premium, tradeDate,
    }));
  }
  const e = sumCosts(entry);
  const x = sumCosts(exit);
  return { entry: e, exit: x, total: Math.round((e.totalCost + x.totalCost) * 100) / 100 };
}

function costLines(rt: ReturnType<typeof roundTripCosts>): string[] {
  const c = rt.entry;
  return [
    `💸 Estimated costs (schedule ${c.scheduleIds.join(', ')}, brokerage ${c.brokeragePlanIds.join(', ')}):`,
    `   Entry: brokerage ₹${c.brokerage.toFixed(2)} | STT ₹${c.stt.toFixed(2)} | exch ₹${(c.exchangeTxn + c.ipft).toFixed(2)} | SEBI ₹${c.sebiFee.toFixed(2)} | stamp ₹${c.stampDuty.toFixed(2)} | GST ₹${c.gst.toFixed(2)} = ₹${c.totalCharges.toFixed(2)}`,
    `   Exit (square-off at same premiums): ₹${rt.exit.totalCharges.toFixed(2)}`,
    `   Round-trip charges (excl. slippage): ₹${rt.total.toFixed(2)}`,
  ];
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const provider = opts.provider ?? createDataProvider();
  const now = opts.now ?? (() => new Date());
  const marketOpen = opts.marketOpen ?? isMarketOpen;
  const chainCache = new MemoryCache<OptionChainData>({ maxSize: 50, ttlMs: 10_000 });

  // ── Lazy provider initialization ───────────────────────────
  // NSE cookie fetch can take 10-15 s, so createServer() must not block.
  let providerReady = provider.isReady();
  let providerInitPromise: Promise<void> | null = null;
  async function ensureProvider(): Promise<void> {
    if (providerReady) return;
    if (!providerInitPromise) {
      providerInitPromise = provider.initialize().then(() => {
        providerReady = true;
        console.error('Data provider initialized: ' + provider.name);
      }).catch((err) => {
        providerInitPromise = null; // allow retry
        throw err;
      });
    }
    await providerInitPromise;
  }
  if (opts.eagerInit !== false) ensureProvider().catch(() => {});

  const server = new McpServer({ name: 'indian-option-mcp', version: '1.1.0' });

  async function getChain(symbol: string, expiry?: string): Promise<{ chain: OptionChainData; quality: Quality }> {
    await ensureProvider();
    const sym = symbol.toUpperCase();
    const key = `${sym}:${expiry ?? 'nearest'}`;
    const chain = await chainCache.getOrFetch(key, () => provider.getOptionChain(sym, expiry));
    const quality = assessFreshness(chain, { now: now(), marketOpen: marketOpen() });
    return { chain, quality };
  }

  function header(title: string, chain: OptionChainData, quality: Quality): string[] {
    return [
      `${title} — ${chain.symbol} | Expiry ${chain.expiryDate} | Spot ₹${formatNumber(chain.underlyingValue)}`,
      `Source timestamp: ${chain.timestamp || 'n/a'}`,
      qualityBanner(quality),
      '',
    ];
  }

  /** Attach market premiums (LTP) and bid/ask to legs; error if any is missing. */
  function priceLegs(chain: OptionChainData, legs: Array<{ type: 'CE' | 'PE'; strike: number; action: 'BUY' | 'SELL'; qty: number }>) {
    const missing: string[] = [];
    const priced = legs.map((l) => {
      const row = chain.rows.find((r) => r.strikePrice === l.strike);
      const opt = row?.[l.type];
      const ltp = opt?.lastPrice ?? null;
      if (ltp === null) missing.push(`${l.type} ${l.strike}`);
      return {
        ...l,
        premium: ltp ?? NaN,
        bid: opt?.bidPrice ?? null,
        ask: opt?.askPrice ?? null,
        expiry: chain.expiryDate,
      };
    });
    if (missing.length) {
      throw new Error(
        `No market price for: ${missing.join(', ')} (expiry ${chain.expiryDate}). ` +
          'Refusing to substitute 0. Choose listed strikes with a last traded price.',
      );
    }
    return priced;
  }

  /** Shared gross / cost / net strategy report. */
  function strategyReport(
    title: string,
    chain: OptionChainData,
    quality: Quality,
    legs: ReturnType<typeof priceLegs>,
    lotSize: number,
    lotNote: string,
    extra: string[] = [],
  ): string {
    const spot = chain.underlyingValue;
    const payoffLegs: PayoffLeg[] = legs.map((l) => ({ type: l.type, strike: l.strike, premium: l.premium, qty: l.qty, action: l.action, expiry: l.expiry }));
    const gross = analyzeExpiryPayoff(payoffLegs, lotSize);
    const rt = roundTripCosts(legs, lotSize, istDate(now()));
    const net = analyzeExpiryPayoff(payoffLegs, lotSize, -rt.total);

    let netPremium = 0;
    for (const l of legs) netPremium += (l.action === 'SELL' ? 1 : -1) * l.premium * l.qty;

    // Executable premium using bid (sell) / ask (buy), if quotes exist.
    let execPremium: number | null = 0;
    for (const l of legs) {
      const px = l.action === 'SELL' ? l.bid : l.ask;
      if (px === null) { execPremium = null; break; }
      execPremium += (l.action === 'SELL' ? 1 : -1) * px * l.qty;
    }

    const lines = [
      ...header(title, chain, quality),
      `Lot size: ${lotSize}. ${lotNote}`,
      '',
      '📐 Legs (premium = LAST TRADED PRICE, not an executable quote):',
      ...legs.map((l) => `  ${l.action} ${l.qty} lot(s) ${l.type} ${l.strike} @ ₹${l.premium.toFixed(2)}  (bid ${fmt(l.bid)} / ask ${fmt(l.ask)})`),
      '',
      `Net premium (LTP): ${netPremium >= 0 ? 'Credit' : 'Debit'} ₹${Math.abs(netPremium).toFixed(2)}/unit = ${formatCurrency(Math.abs(netPremium) * lotSize)} per lot-set`,
      execPremium === null
        ? 'Net premium at bid/ask: n/a (quotes unavailable) — spread cost UNKNOWN'
        : `Net premium at bid/ask: ${execPremium >= 0 ? 'Credit' : 'Debit'} ₹${Math.abs(execPremium).toFixed(2)}/unit (spread cost vs LTP: ₹${((netPremium - execPremium) * lotSize).toFixed(2)})`,
      '',
      'GROSS (at expiry, before costs):',
      `  Max profit: ${rupees(gross.maxProfit)} | Max loss: ${rupees(gross.maxLoss)}`,
      `  Breakevens: ${gross.breakevens.map((b) => '₹' + formatNumber(b, 2)).join(', ') || 'none'}`,
      '',
      ...costLines(rt),
      '',
      'NET (after estimated round-trip charges; slippage NOT included):',
      `  Max profit: ${rupees(net.maxProfit)} | Max loss: ${rupees(net.maxLoss)}`,
      `  Breakevens: ${net.breakevens.map((b) => '₹' + formatNumber(b, 2)).join(', ') || 'none'}`,
      gross.maxProfit > 0 && net.maxProfit <= 0
        ? '  ⚠️ PROFITABLE BEFORE COSTS ONLY — max NET profit ≤ 0.'
        : '',
      gross.maxLoss === -Infinity ? '  ⚠️ UNLIMITED LOSS on the upside (net short calls).' : '',
      '',
      `Spot range shown elsewhere is illustrative only; extremes above are exact for S ∈ [0, ∞). Current spot ₹${formatNumber(spot)}.`,
      ...extra,
      '',
      ANALYTICS_FOOTER,
    ];
    return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  }

  // ════════════════════════════════════════════════════════════
  // OPTION CHAIN TOOLS
  // ════════════════════════════════════════════════════════════

  server.tool(
    'get_option_chain',
    'Get the option chain for ONE expiry of an Indian F&O symbol: LTP, OI, change in OI, volume, IV, bid/ask for calls and puts. Includes a data-quality banner; missing fields print as n/a (never 0).',
    {
      symbol: Symbol,
      expiry: Expiry.optional(),
      strike_range: z.number().int().min(1).max(100).optional().describe('Strikes on each side of ATM (default 10)'),
    },
    async ({ symbol, expiry, strike_range }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const range = strike_range ?? 10;
      const spot = chain.underlyingValue;
      const atm = atmRow(chain).strikePrice;
      const idx = chain.strikePrices.indexOf(atm);
      const window = new Set(chain.strikePrices.slice(Math.max(0, idx - range), idx + range + 1));

      const lines = [
        ...header('📊 Option Chain', chain, quality),
        'CALLS: OI | ChgOI | Vol | IV% | Bid | Ask | LTP  ||  Strike  ||  PUTS: LTP | Bid | Ask | IV% | Vol | ChgOI | OI',
        '-'.repeat(110),
      ];
      const n = (v: number | null) => (v === null ? 'n/a' : formatOI(v));
      for (const row of chain.rows) {
        if (!window.has(row.strikePrice)) continue;
        const c = row.CE, p = row.PE;
        const ce = c ? `${n(c.openInterest)} | ${n(c.changeinOpenInterest)} | ${n(c.totalTradedVolume)} | ${fmt(c.impliedVolatility, 1)} | ${fmt(c.bidPrice)} | ${fmt(c.askPrice)} | ${fmt(c.lastPrice)}` : '—';
        const pe = p ? `${fmt(p.lastPrice)} | ${fmt(p.bidPrice)} | ${fmt(p.askPrice)} | ${fmt(p.impliedVolatility, 1)} | ${n(p.totalTradedVolume)} | ${n(p.changeinOpenInterest)} | ${n(p.openInterest)}` : '—';
        lines.push(`${ce}  ||${row.strikePrice === atm ? '→' : ' '}${row.strikePrice}  ||  ${pe}`);
      }
      lines.push('', `Spot ₹${formatNumber(spot)} | Listed expiries: ${chain.expiryDates.slice(0, 8).join(', ')}${chain.expiryDates.length > 8 ? '…' : ''}`);
      lines.push('OI units: NSE = contracts; Zerodha = units.');
      return text(lines.join('\n'));
    },
  );

  server.tool(
    'get_expiry_dates',
    'List expiry dates published by the data source for an Indian stock or index (authoritative source list, not computed).',
    { symbol: Symbol },
    async ({ symbol }) => {
      const { chain, quality } = await getChain(symbol);
      return text([
        `📅 Expiry dates for ${chain.symbol} (source: ${quality.source}):`,
        ...chain.expiryDates.map((e, i) => `  ${i + 1}. ${e}`),
      ].join('\n'));
    },
  );

  server.tool(
    'get_spot_price',
    'Get the underlying price reported with the option chain, with source timestamp and data-quality status.',
    { symbol: Symbol },
    async ({ symbol }) => {
      const { chain, quality } = await getChain(symbol);
      return text(`${chain.symbol} underlying: ₹${formatNumber(chain.underlyingValue)} (source time: ${chain.timestamp || 'n/a'})\n${qualityBanner(quality)}`);
    },
  );

  // ════════════════════════════════════════════════════════════
  // GREEKS TOOLS (pure functions of the inputs)
  // ════════════════════════════════════════════════════════════

  server.tool(
    'calculate_greeks',
    'Black-Scholes price and Greeks (European, no dividends). Theta per calendar day; vega and rho per 1 percentage point.',
    { spot: Price, strike: Price, expiry_days: Days, iv: IvPct, type: z.enum(['CE', 'PE']), rate: RatePct.optional() },
    async ({ spot, strike, expiry_days, iv, type, rate }) => {
      const T = expiry_days / 365;
      const r = (rate ?? 7) / 100;
      const g = calculateGreeks(spot, strike, T, r, iv / 100, 0, type);
      const price = optionPrice(spot, strike, T, r, iv / 100, 0, type);
      return text([
        `🔢 ${type} ${strike} | spot ₹${spot} | IV ${iv}% | DTE ${expiry_days} | r ${(r * 100).toFixed(2)}% | q 0`,
        `  Theoretical price: ₹${price.toFixed(2)} (model value, not a market quote)`,
        `  Delta ${g.delta.toFixed(4)} | Gamma ${g.gamma.toFixed(6)} | Theta ${g.theta.toFixed(2)} ₹/day | Vega ${g.vega.toFixed(2)} ₹/1%IV | Rho ${g.rho.toFixed(2)} ₹/1%r`,
        '  Assumptions: constant volatility and rate, log-normal underlying, European exercise, calendar-day time.',
      ].join('\n'));
    },
  );

  server.tool(
    'calculate_iv',
    'Implied volatility from an option premium (Newton-Raphson with bisection fallback).',
    { market_price: Price, spot: Price, strike: Price, expiry_days: Days, type: z.enum(['CE', 'PE']), rate: RatePct.optional() },
    async ({ market_price, spot, strike, expiry_days, type, rate }) => {
      const iv = calculateIV(market_price, spot, strike, expiry_days / 365, (rate ?? 7) / 100, type);
      if (iv === null) {
        return text('IV not determinable: price violates no-arbitrage bounds or solver did not converge (check for stale LTP vs spot).');
      }
      return text(`Implied volatility for ${type} ${strike}: ${(iv * 100).toFixed(2)}% (annualised). Sensitive to stale/asynchronous prices.`);
    },
  );

  server.tool(
    'calculate_option_price',
    'Theoretical Black-Scholes option price (model value, not a market quote).',
    { spot: Price, strike: Price, expiry_days: Days, iv: IvPct, type: z.enum(['CE', 'PE']), rate: RatePct.optional() },
    async ({ spot, strike, expiry_days, iv, type, rate }) => {
      const price = optionPrice(spot, strike, expiry_days / 365, (rate ?? 7) / 100, iv / 100, 0, type);
      return text(`Theoretical ${type} ${strike}: ₹${price.toFixed(2)} (spot ₹${spot}, IV ${iv}%, DTE ${expiry_days}).`);
    },
  );

  server.tool(
    'what_if_greeks',
    'Scenario: Black-Scholes price and Greeks under hypothetical spot / IV / days to expiry.',
    { spot: Price, strike: Price, iv: IvPct, days_to_expiry: Days, type: z.enum(['CE', 'PE']), rate: RatePct.optional() },
    async ({ spot, strike, iv, days_to_expiry, type, rate }) => {
      const T = days_to_expiry / 365;
      const r = (rate ?? 7) / 100;
      const g = calculateGreeks(spot, strike, T, r, iv / 100, 0, type);
      const price = optionPrice(spot, strike, T, r, iv / 100, 0, type);
      return text(`🔮 ${type} ${strike} @ spot ₹${spot}, IV ${iv}%, DTE ${days_to_expiry}: price ₹${price.toFixed(2)} | Δ ${g.delta.toFixed(4)} | Γ ${g.gamma.toFixed(6)} | Θ ${g.theta.toFixed(2)}/day | ν ${g.vega.toFixed(2)}`);
    },
  );

  // ════════════════════════════════════════════════════════════
  // STRATEGY TOOLS
  // ════════════════════════════════════════════════════════════

  server.tool(
    'build_strategy',
    'Construct a named options strategy around ATM from the live chain and report GROSS payoff, estimated transaction costs and NET payoff. Analysis only; does not recommend or place trades.',
    {
      symbol: Symbol,
      expiry: Expiry.optional(),
      strategy_name: z.string().trim().min(1).max(64).describe('Strategy key from list_strategies, e.g. iron_condor'),
      otm_offset: z.number().int().min(1).max(50).optional().describe('Strikes away from ATM for OTM legs'),
    },
    async ({ symbol, expiry, strategy_name, otm_offset }) => {
      const template = STRATEGIES[strategy_name];
      if (!template) throw new Error(`Unknown strategy "${strategy_name}". Use list_strategies.`);
      if (MULTI_EXPIRY_STRATEGIES.has(strategy_name)) {
        throw new Error(`${strategy_name} needs two different expiries and is not supported by this builder.`);
      }
      const { chain, quality } = await getChain(symbol, expiry);
      const { lotSize, note } = lotSizeInfo(chain.symbol);
      const interval = inferStrikeInterval(chain);
      const legs = buildStrategy(strategy_name, {
        spotPrice: chain.underlyingValue,
        atmStrike: atmRow(chain).strikePrice,
        strikeInterval: interval,
        expiry: chain.expiryDate,
        otmOffset: otm_offset,
      });
      const priced = priceLegs(chain, legs.map((l) => ({ type: l.type, strike: l.strike, action: l.action, qty: l.qty })));
      return text(strategyReport(`📋 ${template.displayName}`, chain, quality, priced, lotSize, note, [
        `Strike interval used: ${interval} (inferred from listed strikes).`,
        `Template: ${template.description} Risk label (static, not computed): ${template.riskLevel}.`,
      ]));
    },
  );

  server.tool(
    'custom_strategy',
    'Price a custom multi-leg options position from the live chain and report GROSS payoff, estimated costs and NET payoff.',
    { symbol: Symbol, legs: z.array(OptionLeg).min(1).max(8), expiry: Expiry.optional() },
    async ({ symbol, legs, expiry }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const { lotSize, note } = lotSizeInfo(chain.symbol);
      const priced = priceLegs(chain, legs);
      return text(strategyReport('📋 Custom position', chain, quality, priced, lotSize, note));
    },
  );

  server.tool(
    'suggest_strategy',
    'List strategy TEMPLATES whose static category matches an outlook. These are textbook structures, not recommendations, and carry no evidence of positive net expectancy.',
    {
      outlook: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL', 'VOLATILE']),
      risk_level: z.enum(['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH']).optional(),
    },
    async ({ outlook, risk_level }) => {
      const s = suggestStrategies(outlook, risk_level);
      return text([
        `Templates in category ${outlook}${risk_level ? ` (static risk label ≤ ${risk_level})` : ''}:`,
        ...s.map((x, i) => `${i + 1}. ${x.name} — ${x.displayName}: ${x.description}`),
        '',
        'No template has been validated for positive NET expectancy. Evaluate any candidate with build_strategy (net of costs) and the documented validation process.',
      ].join('\n'));
    },
  );

  server.tool(
    'list_strategies',
    'List available strategy templates, optionally filtered by category.',
    { category: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL', 'VOLATILITY']).optional() },
    async ({ category }) => {
      const s = listStrategies(category);
      return text([
        `Strategy templates${category ? ` (${category})` : ''}:`,
        ...s.map((x) => `  • ${x.name.padEnd(28)} ${x.displayName.padEnd(28)} ${x.legCount} legs${MULTI_EXPIRY_STRATEGIES.has(x.name) ? ' (UNSUPPORTED: multi-expiry)' : ''}`),
      ].join('\n'));
    },
  );

  server.tool(
    'calculate_payoff',
    'Expiry payoff for user-supplied legs and premiums: exact GROSS max profit/loss and breakevens, plus NET values after estimated round-trip charges.',
    {
      legs: z.array(PricedLeg).min(1).max(8),
      spot_price: Price.describe('Current spot (for the illustrative table)'),
      lot_size: LotSize,
    },
    async ({ legs, spot_price, lot_size }) => {
      const payoffLegs: PayoffLeg[] = legs.map((l) => ({ ...l, expiry: '' }));
      const grid = calculatePayoffAtExpiry(payoffLegs, { min: spot_price * 0.85, max: spot_price * 1.15, steps: 30 }, lot_size);
      const rt = roundTripCosts(legs, lot_size, istDate(now()));
      const net = analyzeExpiryPayoff(payoffLegs, lot_size, -rt.total);
      return text([
        `📊 Payoff at expiry (lot size ${lot_size})`,
        `GROSS: max profit ${rupees(grid.maxProfit)} | max loss ${rupees(grid.maxLoss)} | breakevens ${grid.breakevens.map((b) => '₹' + formatNumber(b, 2)).join(', ') || 'none'}`,
        ...costLines(rt),
        `NET:   max profit ${rupees(net.maxProfit)} | max loss ${rupees(net.maxLoss)} | breakevens ${net.breakevens.map((b) => '₹' + formatNumber(b, 2)).join(', ') || 'none'}`,
        '',
        'Price      │ GROSS P&L      │ NET P&L',
        ...grid.data
          .filter((_, i) => i % 3 === 0)
          .map((p) => `₹${formatNumber(p.underlyingPrice, 0).padStart(9)} │ ${formatCurrency(p.pnl).padStart(14)} │ ${formatCurrency(p.pnl - rt.total)}`),
        '',
        ANALYTICS_FOOTER,
      ].join('\n'));
    },
  );

  // ════════════════════════════════════════════════════════════
  // OI ANALYSIS TOOLS (heuristics — no validated predictive value)
  // ════════════════════════════════════════════════════════════

  server.tool(
    'calculate_max_pain',
    'Max pain strike for one expiry (strike minimising total option-writer payout). A positioning statistic with no validated predictive value.',
    { symbol: Symbol, expiry: Expiry.optional() },
    async ({ symbol, expiry }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const oi = chain.rows
        .filter((r) => r.CE?.openInterest != null || r.PE?.openInterest != null)
        .map((r) => ({ strike: r.strikePrice, callOI: r.CE?.openInterest ?? 0, putOI: r.PE?.openInterest ?? 0 }));
      if (oi.length === 0) throw new Error('Open interest unavailable for this chain.');
      const res = calculateMaxPain(oi, 1);
      return text([
        ...header('🎯 Max Pain', chain, quality),
        `Max pain strike: ₹${res.maxPainStrike} (${formatPercent(((res.maxPainStrike - chain.underlyingValue) / chain.underlyingValue) * 100)} from spot)`,
        'Lowest-payout strikes (payout in OI-units × ₹):',
        ...[...res.painByStrike].sort((a, b) => a.totalPain - b.totalPain).slice(0, 5)
          .map((p, i) => `  ${i + 1}. ₹${p.strike} — ${formatLargeNumber(p.totalPain)}`),
        '',
        'Heuristic only; not evidence of where the underlying will settle.',
      ].join('\n'));
    },
  );

  server.tool(
    'get_pcr',
    'Put-call ratio (OI, volume, change in OI) for one expiry. Labels are conventional heuristics with no validated edge.',
    { symbol: Symbol, expiry: Expiry.optional() },
    async ({ symbol, expiry }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const rows = chain.rows.map((r) => ({
        strike: r.strikePrice,
        callOI: r.CE?.openInterest ?? 0,
        putOI: r.PE?.openInterest ?? 0,
        callVolume: r.CE?.totalTradedVolume ?? 0,
        putVolume: r.PE?.totalTradedVolume ?? 0,
        callOIChange: r.CE?.changeinOpenInterest ?? undefined,
        putOIChange: r.PE?.changeinOpenInterest ?? undefined,
      }));
      const pcr = calculatePCR(rows);
      const totalCallOI = rows.reduce((a, r) => a + r.callOI, 0);
      const totalCallVol = rows.reduce((a, r) => a + r.callVolume, 0);
      return text([
        ...header('📊 Put-Call Ratio', chain, quality),
        `  OI PCR:     ${totalCallOI > 0 ? pcr.oiPCR.toFixed(3) : 'n/a'}`,
        `  Volume PCR: ${totalCallVol > 0 ? pcr.volumePCR.toFixed(3) : 'n/a'}`,
        `  Change PCR: ${pcr.changePCR?.toFixed(3) ?? 'n/a'}`,
        `  Conventional label (OI PCR > 1.2 "bullish", < 0.8 "bearish"): ${totalCallOI > 0 ? pcr.interpretation : 'n/a'}`,
        '  Heuristic only — not a validated signal.',
      ].join('\n'));
    },
  );

  server.tool(
    'highest_oi_strikes',
    'Strikes with the highest call and put open interest for one expiry (often read as resistance/support; unvalidated heuristic).',
    { symbol: Symbol, expiry: Expiry.optional(), top_n: z.number().int().min(1).max(50).optional() },
    async ({ symbol, expiry, top_n }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const n = top_n ?? 5;
      const a = analyzeOIDistribution(chain.rows.map((r) => ({
        strike: r.strikePrice,
        callOI: r.CE?.openInterest ?? 0,
        putOI: r.PE?.openInterest ?? 0,
        callOIChange: r.CE?.changeinOpenInterest ?? undefined,
        putOIChange: r.PE?.changeinOpenInterest ?? undefined,
      })));
      return text([
        ...header('🏔️ Highest OI', chain, quality),
        'Highest CALL OI:', ...a.topCallOIStrikes.slice(0, n).map((s, i) => `  ${i + 1}. ₹${s.strike} — ${formatOI(s.oi)}`),
        'Highest PUT OI:', ...a.topPutOIStrikes.slice(0, n).map((s, i) => `  ${i + 1}. ₹${s.strike} — ${formatOI(s.oi)}`),
        '', 'Support/resistance readings of OI are heuristics, not validated signals.',
      ].join('\n'));
    },
  );

  server.tool(
    'oi_change_analysis',
    'Largest increases in call and put open interest for one expiry. Requires change-in-OI data (not available from fallback/Zerodha sources).',
    { symbol: Symbol, expiry: Expiry.optional() },
    async ({ symbol, expiry }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      if (quality.unavailableFields.includes('changeinOpenInterest')) {
        return text(`${header('📈 OI change', chain, quality).join('\n')}Change in OI is NOT provided by source "${quality.source}". Analysis unavailable.`);
      }
      const rows = chain.rows.filter((r) => r.CE?.changeinOpenInterest != null || r.PE?.changeinOpenInterest != null);
      const a = analyzeOIDistribution(rows.map((r) => ({
        strike: r.strikePrice,
        callOI: r.CE?.openInterest ?? 0,
        putOI: r.PE?.openInterest ?? 0,
        callOIChange: r.CE?.changeinOpenInterest ?? undefined,
        putOIChange: r.PE?.changeinOpenInterest ?? undefined,
      })));
      return text([
        ...header('📈 OI change', chain, quality),
        `Largest call OI increase: ₹${a.highestCallOIChange.strike} (${a.highestCallOIChange.change >= 0 ? '+' : ''}${formatOI(a.highestCallOIChange.change)})`,
        `Largest put OI increase:  ₹${a.highestPutOIChange.strike} (${a.highestPutOIChange.change >= 0 ? '+' : ''}${formatOI(a.highestPutOIChange.change)})`,
        'Heuristic only.',
      ].join('\n'));
    },
  );

  // ════════════════════════════════════════════════════════════
  // IV ANALYTICS
  // ════════════════════════════════════════════════════════════

  server.tool(
    'iv_smile',
    'Source-published implied volatility across strikes for one expiry, plus a simple 95%/105% skew measure.',
    { symbol: Symbol, expiry: Expiry.optional() },
    async ({ symbol, expiry }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      if (quality.unavailableFields.includes('impliedVolatility')) {
        return text(`${header('📈 IV smile', chain, quality).join('\n')}IV is NOT provided by source "${quality.source}". Unavailable.`);
      }
      const data = chain.rows
        .map((r) => ({ strike: r.strikePrice, callIV: r.CE?.impliedVolatility ?? null, putIV: r.PE?.impliedVolatility ?? null }))
        .filter((d) => d.callIV !== null || d.putIV !== null);
      const spot = chain.underlyingValue;
      const smile = calculateIVSmile(data, spot);
      const skew = calculateIVSkew(data, spot);
      return text([
        ...header('📈 IV smile', chain, quality),
        'Strike    │ K/S    │ Call IV │ Put IV',
        ...smile.filter((p) => Math.abs(p.moneyness - 1) < 0.1)
          .map((p) => `${('₹' + p.strike).padStart(9)} │ ${p.moneyness.toFixed(3)} │ ${fmt(p.callIV, 1).padStart(7)} │ ${fmt(p.putIV, 1)}`),
        '',
        `Skew (OTM put IV − OTM call IV)/ATM IV: ${skew.skew.toFixed(4)} — ${skew.description}`,
      ].join('\n'));
    },
  );

  server.tool(
    'expected_move',
    'One-sigma style expected range to expiry from ATM implied volatility: S·σ·√(T)·k, with T measured to 15:30 IST on expiry day.',
    {
      symbol: Symbol,
      expiry: Expiry.optional(),
      confidence: z.number().finite().positive().max(5).optional().describe('Sigma multiplier: 1≈68%, 1.645≈90%, 1.96≈95% (default 1)'),
    },
    async ({ symbol, expiry, confidence }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const atm = atmRow(chain);
      const ivs = [atm.CE?.impliedVolatility, atm.PE?.impliedVolatility].filter((v): v is number => typeof v === 'number');
      if (ivs.length === 0) {
        throw new Error(`ATM implied volatility unavailable (source ${quality.source}). Expected move not computed.`);
      }
      const atmIV = ivs.reduce((a, b) => a + b, 0) / ivs.length / 100;
      const dte = calendarDaysToExpiry(chain.expiryDate, now());
      if (dte <= 0) throw new Error(`Expiry ${chain.expiryDate} has passed.`);
      const k = confidence ?? 1;
      const move = expectedMove(chain.underlyingValue, atmIV, dte, k);
      return text([
        ...header('📏 Expected move', chain, quality),
        `ATM IV ${(atmIV * 100).toFixed(2)}% (strike ${atm.strikePrice}) | calendar days to 15:30 IST expiry: ${dte.toFixed(2)} | k = ${k}`,
        `Range: ₹${formatNumber(move.lower)} – ₹${formatNumber(move.upper)} (±${formatPercent(move.movePercent)})`,
        'Assumes log-normal moves at constant IV; real distributions have fatter tails.',
      ].join('\n'));
    },
  );

  // ════════════════════════════════════════════════════════════
  // MARKET DATA TOOLS
  // ════════════════════════════════════════════════════════════

  server.tool(
    'market_overview',
    'NIFTY and BANKNIFTY spot, ATM IV and OI PCR for the nearest listed expiry, each with its data-quality status.',
    {},
    async () => {
      const out: string[] = ['📊 Indian market overview', ''];
      for (const idx of ['NIFTY', 'BANKNIFTY']) {
        try {
          const { chain, quality } = await getChain(idx);
          const atm = atmRow(chain);
          const ivs = [atm.CE?.impliedVolatility, atm.PE?.impliedVolatility].filter((v): v is number => typeof v === 'number');
          const callOI = chain.rows.reduce((s, r) => s + (r.CE?.openInterest ?? 0), 0);
          const putOI = chain.rows.reduce((s, r) => s + (r.PE?.openInterest ?? 0), 0);
          out.push(
            `${idx}: ₹${formatNumber(chain.underlyingValue)} | expiry ${chain.expiryDate} | ATM IV ${ivs.length ? (ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(1) + '%' : 'n/a'} | OI PCR ${callOI > 0 ? (putOI / callOI).toFixed(3) : 'n/a'} | ${quality.status} (${quality.source})`,
          );
        } catch (err) {
          out.push(`${idx}: UNAVAILABLE — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      out.push('', `🕐 ${getMarketStatusInfo().message} (clock + local holiday list; UNVERIFIED)`);
      return text(out.join('\n'));
    },
  );

  server.tool(
    'market_status',
    'Clock-based NSE session status (09:15–15:30 IST, weekdays, local holiday list). Does not know about special sessions or unscheduled closures.',
    {},
    async () => {
      const s = getMarketStatusInfo();
      return text(`${s.isOpen ? '🟢' : '🔴'} ${s.message}\nBasis: system clock + local 2026 holiday list (UNVERIFIED). Not authoritative.`);
    },
  );

  server.tool(
    'lot_size',
    'F&O lot size from a static table. UNVERIFIED — NSE revises lot sizes; confirm against the exchange/broker instrument master.',
    { symbol: Symbol },
    async ({ symbol }) => {
      const { lotSize, note } = lotSizeInfo(symbol.toUpperCase());
      return text(`Lot size for ${symbol.toUpperCase()}: ${lotSize} units per lot.\n${note}`);
    },
  );

  server.tool(
    'next_expiry',
    'COMPUTED next expiry from calendar rules (post-2025 Tuesday regime) and a local holiday list. Not authoritative — prefer get_expiry_dates.',
    { symbol: Symbol, weekly: z.boolean().optional() },
    async ({ symbol, weekly }) => {
      const d = getNextExpiry(symbol.toUpperCase(), weekly ?? false, now());
      return text(`Computed next ${weekly ? 'weekly' : 'monthly'} expiry for ${symbol.toUpperCase()}: ${d.toISOString().slice(0, 10)}\n${EXPIRY_RULES_NOTE}`);
    },
  );

  // ════════════════════════════════════════════════════════════
  // RISK TOOLS
  // ════════════════════════════════════════════════════════════

  server.tool(
    'estimate_margin',
    'ROUGH HEURISTIC margin figure. NOT SPAN, known to UNDERSTATE margin for short straddles/strangles. Do not use for risk limits — use the broker margin API.',
    { symbol: Symbol, legs: z.array(PricedLeg).min(1).max(8) },
    async ({ symbol, legs }) => {
      const { chain, quality } = await getChain(symbol);
      const { lotSize, note } = lotSizeInfo(chain.symbol);
      const m = estimateMargin(legs, chain.underlyingValue, lotSize);
      return text([
        `💰 HEURISTIC margin — ${chain.symbol} (spot ₹${formatNumber(chain.underlyingValue)}, ${quality.status})`,
        `  "SPAN-like": ${formatCurrency(m.spanMargin)} | "Exposure-like": ${formatCurrency(m.exposureMargin)} | Total: ${formatCurrency(m.totalMargin)}`,
        `  ${note}`,
        '  ⚠️ Not an exchange SPAN calculation. Known defect: short straddles/strangles are treated as defined-risk spreads. Not fit for risk control.',
      ].join('\n'));
    },
  );

  server.tool(
    'probability_of_profit',
    'Model probability that a position\'s expiry P&L NET of estimated round-trip charges is positive, from its actual payoff (log-normal, single IV, zero drift).',
    {
      legs: z.array(PricedLeg).min(1).max(8),
      lot_size: LotSize,
      spot_price: Price,
      iv: IvPct,
      days_to_expiry: Days,
    },
    async ({ legs, lot_size, spot_price, iv, days_to_expiry }) => {
      const rt = roundTripCosts(legs, lot_size, istDate(now()));
      const T = days_to_expiry / 365;
      const grossPop = probabilityOfProfitFromLegs(legs, lot_size, spot_price, iv / 100, T, 0);
      const netPop = probabilityOfProfitFromLegs(legs, lot_size, spot_price, iv / 100, T, rt.total);
      return text([
        `Model POP (GROSS, before costs): ${(grossPop * 100).toFixed(1)}%`,
        `Model POP (NET of ₹${rt.total.toFixed(2)} estimated charges): ${(netPop * 100).toFixed(1)}%`,
        'POP is not expectancy: a high-POP strategy can have negative net expectancy. Single-IV log-normal model ignores skew and fat tails.',
      ].join('\n'));
    },
  );

  server.tool(
    'position_sizing',
    'Whole lots allowed by a fixed-fraction risk budget: floor(capital × risk% ÷ max loss per lot). Max loss per lot must be in ₹ for ONE lot INCLUDING costs.',
    {
      capital: z.number().finite().positive().max(1e11).describe('Trading capital in ₹'),
      risk_percent: z.number().finite().positive().max(100).describe('Max % of capital at risk per trade'),
      max_loss_per_lot: z.number().finite().positive().max(1e10).describe('Worst-case NET loss of ONE lot in ₹ (finite)'),
    },
    async ({ capital, risk_percent, max_loss_per_lot }) => {
      const r = optimalPositionSize(capital, risk_percent, max_loss_per_lot);
      return text([
        `📐 Risk budget ${formatCurrency(r.riskBudget)} (${risk_percent}% of ${formatCurrency(capital)})`,
        `  Max loss per lot: ${formatCurrency(max_loss_per_lot)}`,
        `  Lots within budget: ${r.lots} (total risk ${formatCurrency(r.totalRisk)}, ${r.capitalAtRiskPercent.toFixed(2)}% of capital)`,
        r.lots === 0 ? '  One lot exceeds the risk budget.' : '',
        '  Arithmetic only. Final limits are enforced by the risk gateway, not by this tool.',
      ].filter(Boolean).join('\n'));
    },
  );

  // ════════════════════════════════════════════════════════════
  // COSTS & TAX
  // ════════════════════════════════════════════════════════════

  server.tool(
    'estimate_transaction_costs',
    'Itemised NSE F&O transaction costs (brokerage, STT, exchange, IPFT, SEBI, stamp duty, GST) for orders, from the versioned charge schedule in force on the trade date.',
    {
      orders: z.array(z.object({
        instrument: z.enum(['OPTION', 'FUTURE']),
        side: z.enum(['BUY', 'SELL']),
        quantity: z.number().int().positive().max(10_000_000).describe('Units (lots × lot size)'),
        price: Premium.describe('Executed price per unit (premium for options)'),
      })).min(1).max(20),
      trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('IST trade date (default today)'),
    },
    async ({ orders, trade_date }) => {
      const date = trade_date ?? istDate(now());
      const items = orders.map((o) => calculateOrderCosts({ ...o, exchange: 'NSE', tradeDate: date }));
      const tot = sumCosts(items);
      return text([
        `💸 Transaction costs for ${date} (schedule ${tot.scheduleIds.join(', ')}; brokerage plan ${DEFAULT_BROKERAGE_PLAN})`,
        ...items.map((c, i) => `  #${i + 1} ${orders[i].side} ${orders[i].instrument} ${orders[i].quantity} @ ₹${orders[i].price}: turnover ₹${c.turnover} | brokerage ${c.brokerage} | STT ${c.stt} | exch ${c.exchangeTxn} | IPFT ${c.ipft} | SEBI ${c.sebiFee} | stamp ${c.stampDuty} | GST ${c.gst} | total ₹${c.totalCharges}`),
        `  TOTAL charges: ₹${tot.totalCharges.toFixed(2)} (slippage not included)`,
        ...tot.assumptions.map((a) => `  Assumption: ${a}`),
        '  Rates are configuration (src/config/charges) with recorded sources; several are UNVERIFIED against primary sources.',
      ].join('\n'));
    },
  );

  server.tool(
    'estimate_tax',
    'ANNUAL income-tax ESTIMATE on aggregated NET F&O trading P&L (non-speculative business income, new regime). Not tax advice; not a confirmed liability.',
    {
      financial_year: z.enum(['FY2025-26', 'FY2026-27']),
      net_trading_pnl: z.number().finite().min(-1e11).max(1e11).describe('Annual NET trading P&L after all transaction costs (₹)'),
      other_taxable_income: z.number().finite().min(0).max(1e11).optional(),
      other_trading_expenses: z.number().finite().min(0).max(1e11).optional(),
      resident_individual: z.boolean().default(true),
    },
    async ({ financial_year, net_trading_pnl, other_taxable_income, other_trading_expenses, resident_individual }) => {
      const e = estimateTax({
        financialYear: financial_year,
        netTradingPnL: net_trading_pnl,
        otherTaxableIncome: other_taxable_income,
        otherTradingExpenses: other_trading_expenses,
        residentIndividual: resident_individual,
      });
      return text([
        `🧾 ${TAX_ESTIMATE_LABEL}`,
        `Rules: ${e.ruleVersion} (${e.regime} regime, ${e.treatment})`,
        `  NET trading P&L (input):                 ${formatCurrency(net_trading_pnl)}`,
        `  Estimated taxable trading income:        ${formatCurrency(e.estimatedTaxableTradingIncome)}`,
        e.tradingLossNotSetOff ? `  Trading loss (not set off here):         ${formatCurrency(e.tradingLossNotSetOff)}` : '',
        `  Estimated total income:                  ${formatCurrency(e.estimatedTotalIncome)}`,
        `  Estimated tax attributable to trading:   ${formatCurrency(e.estimatedTaxAttributableToTrading)}`,
        `  After-tax trading ESTIMATE:              ${formatCurrency(e.afterTaxTradingEstimate)}`,
        '',
        'Assumptions:',
        ...e.assumptions.map((a) => `  - ${a}`),
      ].filter(Boolean).join('\n'));
    },
  );

  // ════════════════════════════════════════════════════════════
  // SCANNERS
  // ════════════════════════════════════════════════════════════

  server.tool(
    'scan_high_oi',
    'Top-10 call and put strikes by open interest for one expiry.',
    { symbol: Symbol, expiry: Expiry.optional(), min_oi: z.number().finite().min(0).optional() },
    async ({ symbol, expiry, min_oi }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const t = min_oi ?? 0;
      const top = (side: 'CE' | 'PE') => chain.rows
        .filter((r) => (r[side]?.openInterest ?? -1) > t)
        .sort((a, b) => (b[side]!.openInterest ?? 0) - (a[side]!.openInterest ?? 0))
        .slice(0, 10)
        .map((r) => `  ₹${r.strikePrice} — OI ${formatOI(r[side]!.openInterest ?? 0)} | LTP ${fmt(r[side]!.lastPrice)}`);
      return text([...header('🔍 High OI', chain, quality), 'Calls:', ...top('CE'), '', 'Puts:', ...top('PE')].join('\n'));
    },
  );

  server.tool(
    'unusual_activity',
    'Strikes whose traded volume / open interest exceeds a threshold for one expiry. Descriptive only.',
    { symbol: Symbol, expiry: Expiry.optional(), threshold: z.number().finite().positive().max(1000).optional() },
    async ({ symbol, expiry, threshold }) => {
      const { chain, quality } = await getChain(symbol, expiry);
      const th = threshold ?? 0.5;
      const hits: Array<{ ratio: number; line: string }> = [];
      for (const row of chain.rows) {
        for (const side of ['CE', 'PE'] as const) {
          const o = row[side];
          if (!o || o.openInterest === null || o.totalTradedVolume === null || o.openInterest <= 0) continue;
          const ratio = o.totalTradedVolume / o.openInterest;
          if (ratio > th) hits.push({ ratio, line: `${side} ${row.strikePrice}: Vol/OI ${ratio.toFixed(2)} (vol ${formatOI(o.totalTradedVolume)}, OI ${formatOI(o.openInterest)})` });
        }
      }
      hits.sort((a, b) => b.ratio - a.ratio);
      return text([
        ...header(`⚡ Vol/OI > ${th}`, chain, quality),
        hits.length ? hits.slice(0, 20).map((h) => h.line).join('\n') : 'None above threshold.',
        'NSE volume is in contracts and OI in contracts; ratios are unit-consistent per source.',
      ].join('\n'));
    },
  );

  // ════════════════════════════════════════════════════════════
  // RESOURCES & PROMPTS
  // ════════════════════════════════════════════════════════════

  server.resource('market-status', 'market://status', async () => ({
    contents: [{
      uri: 'market://status',
      text: JSON.stringify({ ...getMarketStatusInfo(), basis: 'clock+local-holiday-list (unverified)', timestamp: now().toISOString() }),
    }],
  }));

  server.prompt(
    'strategy_advisor',
    'Structured, analysis-only review of option structures for a symbol and outlook (no recommendations, net of costs).',
    {
      symbol: z.string().max(32).describe('Symbol to analyse'),
      outlook: z.enum(['bullish', 'bearish', 'neutral', 'volatile']).describe('Stated market view (an input, not a forecast)'),
      capital: z.string().max(20).optional().describe('Capital in ₹ (for risk arithmetic only)'),
    },
    ({ symbol, outlook, capital }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Analyse option structures for ${symbol.toUpperCase()} given a stated ${outlook} view.`,
            capital ? `Capital for risk arithmetic: ₹${capital}.` : '',
            '',
            'Rules:',
            '- Report the DATA QUALITY banner of every tool; do not draw conclusions from STALE/DEGRADED/UNAVAILABLE data.',
            '- Present GROSS, COSTS and NET for every structure; judge only on NET figures.',
            '- Do NOT recommend a trade, do not express confidence, and do not claim any structure is profitable.',
            '- State that no structure has validated positive net expectancy.',
            '',
            'Steps: get_option_chain → expected_move → suggest_strategy → build_strategy for 2–3 templates → probability_of_profit (net) → position_sizing using NET max loss.',
          ].filter(Boolean).join('\n'),
        },
      }],
    }),
  );

  server.prompt(
    'market_analysis',
    'Descriptive, analysis-only snapshot of an Indian F&O symbol.',
    { symbol: z.string().max(32).describe('Symbol to analyse') },
    ({ symbol }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Describe the current options market for ${symbol.toUpperCase()}.`,
            'Use: market_overview, get_option_chain, highest_oi_strikes, get_pcr, calculate_max_pain, expected_move, iv_smile, oi_change_analysis.',
            'Report each tool\'s DATA QUALITY. Describe; do not predict or recommend. Label OI/PCR/max-pain readings as unvalidated heuristics.',
          ].join('\n'),
        },
      }],
    }),
  );

  return server;
}
