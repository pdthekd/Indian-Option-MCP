/**
 * @module utils/format
 * Formatting utilities for Indian currency, numbers, and options data display.
 */

/**
 * Format a number as Indian currency: ₹1,23,456.78
 * Uses the Indian numbering system (lakhs and crores).
 */
export function formatCurrency(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}₹${formatted}`;
}

/**
 * Format a number with commas (Indian numbering system).
 */
export function formatNumber(num: number, decimals: number = 2): string {
  return num.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a percentage with +/- sign.
 */
export function formatPercent(value: number, decimals: number = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Format large numbers: 1.5L, 2.3Cr, etc.
 */
export function formatLargeNumber(num: number): string {
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';

  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/**
 * Format Open Interest with K/L/Cr suffix.
 */
export function formatOI(oi: number): string {
  if (oi >= 1e7) return `${(oi / 1e7).toFixed(2)} Cr`;
  if (oi >= 1e5) return `${(oi / 1e5).toFixed(2)} L`;
  if (oi >= 1e3) return `${(oi / 1e3).toFixed(1)} K`;
  return oi.toString();
}

/**
 * Format P&L with color-coded prefix.
 */
export function formatPnL(pnl: number): string {
  if (pnl > 0) return `+${formatCurrency(pnl)} (Profit)`;
  if (pnl < 0) return `${formatCurrency(pnl)} (Loss)`;
  return '₹0.00 (Breakeven)';
}
