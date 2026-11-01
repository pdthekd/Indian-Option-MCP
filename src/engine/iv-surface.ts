/**
 * @module engine/iv-surface
 * Implied volatility smile, skew and expected move for one expiry.
 */

/** Data point for IV smile visualization */
export interface IVSmilePoint {
  strike: number;
  moneyness: number;
  callIV: number | null;
  putIV: number | null;
  avgIV: number | null;
}

/** IV skew analysis result */
export interface IVSkewResult {
  skew: number;
  description: string;
  otmPutIV: number;
  atmIV: number;
  otmCallIV: number;
}

/**
 * Calculate IV smile across strikes for a single expiry.
 * Returns IV plotted against moneyness (K/S).
 *
 * @param chainData - Array of {strike, callIV?, putIV?}
 * @param spotPrice - Current underlying price
 */
export function calculateIVSmile(
  chainData: Array<{ strike: number; callIV?: number | null; putIV?: number | null }>,
  spotPrice: number
): IVSmilePoint[] {
  return chainData
    .filter(d => d.callIV || d.putIV)
    .map(d => {
      const moneyness = d.strike / spotPrice;
      const callIV = d.callIV && d.callIV > 0 ? d.callIV : null;
      const putIV = d.putIV && d.putIV > 0 ? d.putIV : null;
      let avgIV: number | null = null;
      if (callIV !== null && putIV !== null) {
        avgIV = (callIV + putIV) / 2;
      } else {
        avgIV = callIV ?? putIV;
      }
      return { strike: d.strike, moneyness, callIV, putIV, avgIV };
    })
    .sort((a, b) => a.strike - b.strike);
}

/**
 * Calculate IV skew: measures the difference between OTM put and OTM call IV.
 * A positive skew (normal) means OTM puts are more expensive — reflecting demand
 * for downside protection.
 *
 * Skew = (25Δ Put IV - 25Δ Call IV) / ATM IV
 *
 * @param chainData - Array of {strike, callIV?, putIV?}
 * @param spotPrice - Current underlying price
 */
export function calculateIVSkew(
  chainData: Array<{ strike: number; callIV?: number | null; putIV?: number | null }>,
  spotPrice: number
): IVSkewResult {
  const sorted = chainData
    .filter(d => (d.callIV && d.callIV > 0) || (d.putIV && d.putIV > 0))
    .sort((a, b) => a.strike - b.strike);

  if (sorted.length < 3) {
    return { skew: 0, description: 'Insufficient data', otmPutIV: 0, atmIV: 0, otmCallIV: 0 };
  }

  // Find ATM strike (closest to spot)
  const atmIdx = sorted.reduce((closest, d, i) =>
    Math.abs(d.strike - spotPrice) < Math.abs(sorted[closest].strike - spotPrice) ? i : closest, 0);

  const atmData = sorted[atmIdx];
  const atmIV = (atmData.callIV || atmData.putIV || 0);

  if (atmIV <= 0) {
    return { skew: 0, description: 'ATM IV not available', otmPutIV: 0, atmIV: 0, otmCallIV: 0 };
  }

  // OTM Put: ~5% below spot
  const targetPutStrike = spotPrice * 0.95;
  const otmPutData = sorted.reduce((closest, d) =>
    d.strike < spotPrice && Math.abs(d.strike - targetPutStrike) < Math.abs(closest.strike - targetPutStrike) ? d : closest, sorted[0]);
  const otmPutIV = otmPutData.putIV || otmPutData.callIV || 0;

  // OTM Call: ~5% above spot
  const targetCallStrike = spotPrice * 1.05;
  const otmCallData = sorted.reduce((closest, d) =>
    d.strike > spotPrice && Math.abs(d.strike - targetCallStrike) < Math.abs(closest.strike - targetCallStrike) ? d : closest, sorted[sorted.length - 1]);
  const otmCallIV = otmCallData.callIV || otmCallData.putIV || 0;

  const skew = atmIV > 0 ? (otmPutIV - otmCallIV) / atmIV : 0;

  let description: string;
  if (skew > 0.15) description = 'Strong put skew — significant downside fear';
  else if (skew > 0.05) description = 'Normal put skew — typical market conditions';
  else if (skew > -0.05) description = 'Flat skew — balanced sentiment';
  else if (skew > -0.15) description = 'Call skew — upside demand exceeds downside';
  else description = 'Strong call skew — extreme bullish demand';

  return { skew, description, otmPutIV, atmIV, otmCallIV };
}

/**
 * Calculate Expected Move based on ATM straddle / IV.
 * Expected Move = Spot × IV × √(DTE/365)
 *
 * At 1σ (68% confidence), the market expects the underlying to stay within ±ExpectedMove.
 *
 * @param spotPrice - Current underlying price
 * @param iv - ATM implied volatility (annualized, decimal e.g. 0.15 for 15%)
 * @param daysToExpiry - Calendar days to expiry
 * @param confidence - Confidence level (1 for 68%, 1.645 for 90%, 1.96 for 95%, 2.576 for 99%)
 */
export function expectedMove(
  spotPrice: number,
  iv: number,
  daysToExpiry: number,
  confidence: number = 1
): { upper: number; lower: number; range: number; movePercent: number } {
  const move = spotPrice * iv * Math.sqrt(daysToExpiry / 365) * confidence;
  return {
    upper: spotPrice + move,
    lower: spotPrice - move,
    range: move * 2,
    movePercent: (move / spotPrice) * 100,
  };
}
