/**
 * @module data/constants/expiry-calendar
 * @description Expiry date computation for NSE F&O contracts.
 *
 * **NSE Expiry Rules (2025–2026):**
 *
 * - **Weekly expiries** (indices only):
 *   - NIFTY — Thursday
 *   - BANKNIFTY — Wednesday
 *   - FINNIFTY — Tuesday
 *   - MIDCPNIFTY — Monday
 *   - SENSEX — Friday
 *
 * - **Monthly expiries** (all stocks & indices):
 *   - Last Thursday of the calendar month.
 *
 * - If the computed expiry day is an exchange holiday, it shifts to the
 *   **previous trading day** (i.e. backward, not forward).
 *
 * This module provides helpers to compute the next expiry, list upcoming
 * expiries, and check whether today is an expiry day.
 */

// Holidays come from the single shared list in ./holidays.ts.
import { isNseTradingHoliday } from './holidays.js';

// ---------------------------------------------------------------------------
// Helpers: Holiday / Trading Day
// ---------------------------------------------------------------------------

/**
 * Format a Date as `YYYY-MM-DD` in UTC.
 */
function toDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Check whether a given date is an NSE holiday.
 *
 * @param date - The date to check.
 * @returns `true` if the date falls on a known NSE trading holiday.
 */
export function isNseHoliday(date: Date): boolean {
  const key = toDateKey(date);
  return isNseTradingHoliday(key);
}

/**
 * Check whether a date is a weekend (Saturday or Sunday).
 */
function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Check whether a date is a valid trading day (not a weekend and not a holiday).
 *
 * @param date - The date to check.
 */
export function isTradingDay(date: Date): boolean {
  return !isWeekend(date) && !isNseHoliday(date);
}

/**
 * Shift a date backward to the previous trading day if it falls on a
 * weekend or holiday.  Returns the date unchanged if it is already a
 * trading day.
 *
 * @param date - The candidate date (mutated in place for efficiency).
 */
function shiftToPreviousTradingDay(date: Date): Date {
  const result = new Date(date);
  while (!isTradingDay(result)) {
    result.setUTCDate(result.getUTCDate() - 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Weekly Expiry Day Mapping
// ---------------------------------------------------------------------------

/**
 * Day-of-week for weekly expiry, keyed by uppercase symbol.
 *
 * | Symbol      | Day       | `getUTCDay()` |
 * | ----------- | --------- | ------------- |
 * | NIFTY       | Thursday  | 4             |
 * | BANKNIFTY   | Wednesday | 3             |
 * | FINNIFTY    | Tuesday   | 2             |
 * | MIDCPNIFTY  | Monday    | 1             |
 * | SENSEX      | Friday    | 5             |
 */
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ RULES IN FORCE FROM 2025-09-01 (SEBI: one expiry day per exchange; NSE   │
// │ chose Tuesday, BSE Thursday; one weekly benchmark index per exchange).   │
// │ The table above describes the PREVIOUS regime and is kept for history.   │
// │ These computed dates are NOT authoritative: always prefer the expiry     │
// │ list published by the exchange / broker instrument master.               │
// └──────────────────────────────────────────────────────────────────────────┘
const WEEKLY_EXPIRY_DAY: Readonly<Record<string, number>> = {
  NIFTY: 2,       // Tuesday (NSE)
  SENSEX: 4,      // Thursday (BSE)
};

/** Symbols whose derivatives are listed on BSE (monthly expiry on Thursday). */
const BSE_SYMBOLS: ReadonlySet<string> = new Set(['SENSEX', 'BANKEX']);

/**
 * Monthly expiry day-of-week: last Tuesday (NSE) / last Thursday (BSE).
 */
const MONTHLY_EXPIRY_DOW = 2; // Tuesday (NSE)
const BSE_MONTHLY_EXPIRY_DOW = 4; // Thursday (BSE)

function monthlyDow(symbol: string): number {
  return BSE_SYMBOLS.has(symbol) ? BSE_MONTHLY_EXPIRY_DOW : MONTHLY_EXPIRY_DOW;
}

/** Human-readable statement of the rules used by this module. */
export const EXPIRY_RULES_NOTE =
  'Computed from rules in force since 2025-09-01 (NSE: NIFTY weekly Tuesday, monthly = last Tuesday; ' +
  'BANKNIFTY/FINNIFTY/MIDCPNIFTY monthly only; BSE SENSEX weekly Thursday) with the official NSE F&O holiday lists (2025: NSE/FAOP/65588; 2026: NSE/FAOP/71777; other years: none). ' +
  'Not authoritative — use the exchange/broker expiry list.';

// ---------------------------------------------------------------------------
// Core Expiry Computation
// ---------------------------------------------------------------------------

/**
 * Find the next occurrence of a given day-of-week on or after `from`.
 */
function nextDayOfWeek(from: Date, dow: number): Date {
  const result = new Date(from);
  const diff = (dow - result.getUTCDay() + 7) % 7;
  result.setUTCDate(result.getUTCDate() + (diff === 0 ? 0 : diff));
  return result;
}

/**
 * Find the last occurrence of a given day-of-week in a specific month/year.
 */
function lastDayOfWeekInMonth(
  year: number,
  month: number,
  dow: number,
): Date {
  // Start from the last day of the month and walk backward.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)); // day 0 of next month = last day
  const diff = (lastDay.getUTCDay() - dow + 7) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - diff);
  return lastDay;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the next expiry date for a given symbol.
 *
 * @param symbol  - NSE symbol (e.g. `"NIFTY"`, `"BANKNIFTY"`, `"RELIANCE"`).
 * @param weekly  - If `true`, return the next weekly expiry (indices only).
 *                  If `false` or omitted, return the next monthly expiry.
 *                  For stock symbols, weekly is always ignored (stocks only
 *                  have monthly expiries).
 * @param from    - Reference date; defaults to now.
 * @returns The next expiry as a UTC midnight `Date`.
 *
 * @example
 * ```ts
 * getNextExpiry('NIFTY', true);   // Next weekly NIFTY expiry (Thursday)
 * getNextExpiry('RELIANCE');      // Next monthly RELIANCE expiry
 * ```
 */
export function getNextExpiry(
  symbol: string,
  weekly = false,
  from: Date = new Date(),
): Date {
  const upper = symbol.toUpperCase().trim();
  const today = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );

  if (weekly && upper in WEEKLY_EXPIRY_DAY) {
    // Weekly expiry for this index
    const dow = WEEKLY_EXPIRY_DAY[upper]!;
    let candidate = nextDayOfWeek(today, dow);
    candidate = shiftToPreviousTradingDay(candidate);

    // If the adjusted expiry is in the past (before today), skip to next week
    if (candidate < today) {
      const nextWeek = new Date(today);
      nextWeek.setUTCDate(nextWeek.getUTCDate() + 1);
      candidate = nextDayOfWeek(nextWeek, dow);
      candidate = shiftToPreviousTradingDay(candidate);
    }
    return candidate;
  }

  // Monthly expiry — last Thursday of the current month, or next if passed
  let year = today.getUTCFullYear();
  let month = today.getUTCMonth();

  let candidate = shiftToPreviousTradingDay(
    lastDayOfWeekInMonth(year, month, monthlyDow(upper)),
  );

  if (candidate < today) {
    // This month's monthly expiry is past — move to next month
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = shiftToPreviousTradingDay(
      lastDayOfWeekInMonth(year, month, monthlyDow(upper)),
    );
  }

  return candidate;
}
