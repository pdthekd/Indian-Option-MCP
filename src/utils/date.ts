/**
 * @module utils/date
 * NSE regular-session status from the clock and the holiday list (utils/time.ts instants, the
 * expiry calendar's trading-day rule). Special sessions and unscheduled closures are not known.
 */

import { istDate, istMinutes } from './time.js';
import { isTradingDay } from '../data/constants/expiry-calendar.js';

const OPEN = 9 * 60 + 15;
const CLOSE = 15 * 60 + 30;

const isTradingDate = (now: Date) => isTradingDay(new Date(`${istDate(now)}T00:00:00Z`));

/** Regular session 09:15–15:30 IST on NSE trading days. */
export function isMarketOpen(now: Date = new Date()): boolean {
  const m = istMinutes(now);
  return isTradingDate(now) && m >= OPEN && m < CLOSE;
}

/** Market status with a short message. */
export function getMarketStatusInfo(now: Date = new Date()): { isOpen: boolean; message: string } {
  if (!isTradingDate(now)) return { isOpen: false, message: 'Market closed (holiday/weekend)' };
  const m = istMinutes(now);
  if (m < 9 * 60) return { isOpen: false, message: 'Market opens at 9:15 AM IST' };
  if (m < OPEN) return { isOpen: false, message: 'Pre-open session in progress' };
  if (m < CLOSE) return { isOpen: true, message: 'Market is open' };
  return { isOpen: false, message: 'Market closed for the day' };
}
