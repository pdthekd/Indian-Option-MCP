/**
 * Regime breakdown of NET trade results.
 *
 * Thresholds are PRE-DECLARED here (2026-10-04, before any regime result was computed) and must
 * not be changed to make a bucket look better. Regime labels known at the signal are "ex-ante";
 * labels that use the holding period are "ex-post" and only describe what happened — they can
 * never become an entry rule.
 * No rule may be derived from these tables without a new pre-registered experiment
 * (docs/EXPERIMENT_PROTOCOL.md).
 */

export const REGIME_THRESHOLDS = Object.freeze({
  declared: '2026-10-04',
  realizedVolLookbackDays: 20,
  /** Annualized close-to-close realized vol of the underlying (fraction). */
  volLow: 0.12,
  volHigh: 0.18,
  trendLookbackDays: 20,
  trendUp: 0.03,
  trendDown: -0.03,
  /** A daily underlying move at least this large is a "large move" (ex-post). */
  largeDailyMove: 0.015,
  minBucketForComment: 20,
});

export interface RegimeTradeInput {
  tradeId: string;
  signalDate: string;
  entryDate: string;
  expiry: string;
  netPnL: number;
  isMonthlyExpiry: boolean;
  /** Development / out-of-sample split label. */
  period: 'DEVELOPMENT' | 'OUT_OF_SAMPLE';
}

export interface RegimeLabels {
  vol: 'LOW_VOL' | 'MID_VOL' | 'HIGH_VOL' | 'UNKNOWN';
  trend: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
  expiryKind: 'MONTHLY' | 'WEEKLY';
  expiryWeekday: string;
  period: 'DEVELOPMENT' | 'OUT_OF_SAMPLE';
  /** Ex-post. */
  largeMoveInHolding: 'LARGE_MOVE' | 'NO_LARGE_MOVE' | 'UNKNOWN';
}

export interface BucketStats {
  regime: string;
  label: string;
  trades: number;
  net: number;
  meanNet: number;
  winRate: number;
  worst: number;
  sufficient: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Annualized realized vol over the `n` daily log returns ending at index i (inclusive). */
export function realizedVol(closes: readonly number[], i: number, n: number): number | null {
  if (i - n < 0) return null;
  const rets: number[] = [];
  for (let k = i - n + 1; k <= i; k++) rets.push(Math.log(closes[k] / closes[k - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * 252);
}

export function labelTrade(t: RegimeTradeInput, dates: readonly string[], closes: readonly number[]): RegimeLabels {
  const T = REGIME_THRESHOLDS;
  const i = dates.indexOf(t.signalDate);
  const rv = i >= 0 ? realizedVol(closes, i, T.realizedVolLookbackDays) : null;
  const tr = i >= T.trendLookbackDays ? closes[i] / closes[i - T.trendLookbackDays] - 1 : null;
  let large: RegimeLabels['largeMoveInHolding'] = 'UNKNOWN';
  const a = dates.indexOf(t.entryDate), b = dates.indexOf(t.expiry);
  if (a >= 1 && b >= a) {
    large = 'NO_LARGE_MOVE';
    for (let k = a + 1; k <= b; k++) if (Math.abs(closes[k] / closes[k - 1] - 1) >= T.largeDailyMove) large = 'LARGE_MOVE';
  }
  return {
    vol: rv === null ? 'UNKNOWN' : rv < T.volLow ? 'LOW_VOL' : rv > T.volHigh ? 'HIGH_VOL' : 'MID_VOL',
    trend: tr === null ? 'UNKNOWN' : tr > T.trendUp ? 'UP' : tr < T.trendDown ? 'DOWN' : 'FLAT',
    expiryKind: t.isMonthlyExpiry ? 'MONTHLY' : 'WEEKLY',
    expiryWeekday: new Date(`${t.expiry}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    period: t.period,
    largeMoveInHolding: large,
  };
}

export function bucketize(trades: readonly RegimeTradeInput[], labels: readonly RegimeLabels[]): BucketStats[] {
  const out: BucketStats[] = [];
  const keys: Array<keyof RegimeLabels> = ['vol', 'trend', 'expiryKind', 'expiryWeekday', 'period', 'largeMoveInHolding'];
  for (const key of keys) {
    const groups = new Map<string, number[]>();
    trades.forEach((t, i) => {
      const g = String(labels[i][key]);
      groups.set(g, [...(groups.get(g) ?? []), t.netPnL]);
    });
    for (const [label, nets] of [...groups.entries()].sort()) {
      const net = nets.reduce((a, b) => a + b, 0);
      out.push({
        regime: key, label, trades: nets.length, net: r2(net), meanNet: r2(net / nets.length),
        winRate: Math.round((nets.filter((n) => n > 0).length / nets.length) * 1000) / 1000, worst: r2(Math.min(...nets)),
        sufficient: nets.length >= REGIME_THRESHOLDS.minBucketForComment,
      });
    }
  }
  return out;
}
