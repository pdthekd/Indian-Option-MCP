/**
 * @module utils/time
 * Time-zone-independent instants for Indian F&O contracts.
 *
 * All functions take explicit `now` instants so results are deterministic and
 * testable. IST is a fixed UTC+05:30 offset (India has no DST).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** NSE equity-derivatives contracts stop trading at 15:30 IST on expiry day. */
export const EXPIRY_CLOSE_IST = { hour: 15, minute: 30 } as const;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse an expiry given as `YYYY-MM-DD` or `DD-Mon-YYYY` into an ISO
 * `YYYY-MM-DD` calendar date. Returns null when the input is not a valid date.
 */
export function normalizeExpiry(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const nse = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (iso) {
    y = Number(iso[1]); m = Number(iso[2]) - 1; d = Number(iso[3]);
  } else if (nse) {
    const mon = MONTHS[nse[2].toLowerCase()];
    if (mon === undefined) return null;
    y = Number(nse[3]); m = mon; d = Number(nse[1]);
  } else {
    return null;
  }
  const check = new Date(Date.UTC(y, m, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m || check.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The UTC instant of 15:30 IST on the given expiry date. */
export function expiryInstant(expiryIso: string): Date {
  const norm = normalizeExpiry(expiryIso);
  if (!norm) throw new Error(`Invalid expiry date: ${expiryIso}`);
  const [y, m, d] = norm.split('-').map(Number);
  return new Date(
    Date.UTC(y, m - 1, d, EXPIRY_CLOSE_IST.hour, EXPIRY_CLOSE_IST.minute) - IST_OFFSET_MS,
  );
}

/**
 * Time to expiry in years (calendar time, 365-day year) from `now` until
 * 15:30 IST on expiry day. Returns 0 at or after expiry — callers must treat
 * T = 0 as "expired" rather than substituting an arbitrary floor.
 */
export function timeToExpiryYears(expiryIso: string, now: Date = new Date()): number {
  const ms = expiryInstant(expiryIso).getTime() - now.getTime();
  return ms > 0 ? ms / MS_PER_YEAR : 0;
}

/** Fractional calendar days to expiry (0 once expired). */
export function calendarDaysToExpiry(expiryIso: string, now: Date = new Date()): number {
  return timeToExpiryYears(expiryIso, now) * 365;
}

/** Calendar date (YYYY-MM-DD) in IST for an instant. */
export function istDate(now: Date = new Date()): string {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  return t.toISOString().slice(0, 10);
}

/**
 * Parse NSE timestamps such as "03-Oct-2026 15:30:00" (IST) into a UTC
 * instant. Also accepts ISO-8601 strings. Returns null when unparseable —
 * never substitutes "now".
 */
export function parseSourceTimestamp(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined) return null;
    const utc = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
    return new Date(utc - IST_OFFSET_MS);
  }
  // Kite Connect style "2026-10-03 15:29:59" (IST, no offset).
  const k = /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (k) {
    const utc = Date.UTC(Number(k[1]), Number(k[2]) - 1, Number(k[3]), Number(k[4]), Number(k[5]), Number(k[6]));
    return new Date(utc - IST_OFFSET_MS);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
