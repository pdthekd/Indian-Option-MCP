/**
 * @module data/constants/holidays
 *
 * The ONLY NSE trading-holiday list in the codebase (expiry calendar and
 * market-status both read from here). Each year records its source and
 * verification level. Years without a list are reported as UNKNOWN so
 * callers can flag computed dates as unverified.
 */

export type HolidayVerification = 'OFFICIAL' | 'UNVERIFIED' | 'UNKNOWN';

export interface HolidayYear {
  year: number;
  verification: HolidayVerification;
  source: string;
  /** Weekday trading holidays, YYYY-MM-DD → description. */
  holidays: Readonly<Record<string, string>>;
  /** Holidays that fall on a weekend (informational). */
  weekendHolidays?: Readonly<Record<string, string>>;
  notes: string[];
}

const YEARS: Readonly<Record<number, HolidayYear>> = Object.freeze({
  2024: {
    year: 2024,
    verification: 'OFFICIAL',
    source:
      'NSE circular NSE/FAOP/59723 (Circular Ref. No. 188/2023), 12 Dec 2023, Futures & Options segment, ' +
      '"Trading holidays for the calendar year 2024", https://nsearchives.nseindia.com/content/circulars/FAOP59723.pdf, ' +
      'plus special closures (see notes) — read 2026-10-04',
    holidays: {
      '2024-01-26': 'Republic Day',
      '2024-03-08': 'Mahashivratri',
      '2024-03-25': 'Holi',
      '2024-03-29': 'Good Friday',
      '2024-04-11': 'Id-Ul-Fitr (Ramadan Eid)',
      '2024-04-17': 'Shri Ram Navmi',
      '2024-05-01': 'Maharashtra Day',
      '2024-05-20': 'Special holiday: Parliamentary elections in Mumbai (NSE/CMTR/61518)',
      '2024-06-17': 'Bakri Id',
      '2024-07-17': 'Moharram',
      '2024-08-15': 'Independence Day/Parsi New Year',
      '2024-10-02': 'Mahatma Gandhi Jayanti',
      '2024-11-01': 'Diwali Laxmi Pujan (Muhurat trading session held)',
      '2024-11-15': 'Gurunanak Jayanti',
      '2024-11-20': 'Special holiday: Maharashtra assembly elections (confirmed by absence of an F&O bhavcopy)',
      '2024-12-25': 'Christmas',
    },
    notes: [
      '2024-05-20 added by NSE/CMTR/61518 (8 Apr 2024). 2024-11-20 is not in the annual circular; it is included because no ' +
        'F&O bhavcopy exists for that date (special closure for the Maharashtra assembly elections, reported at the time).',
      'Muhurat trading was conducted on 2024-11-01 (a holiday); that special session is not a regular trading day.',
    ],
  },
  2025: {
    year: 2025,
    verification: 'OFFICIAL',
    source:
      'NSE circular NSE/FAOP/65588 (Circular Ref. No. 161/2024), 13 Dec 2024, Futures & Options segment, ' +
      '"Trading holidays for the calendar year 2025", https://nsearchives.nseindia.com/content/circulars/FAOP65588.pdf — read 2026-10-04',
    holidays: {
      '2025-02-26': 'Mahashivratri',
      '2025-03-14': 'Holi',
      '2025-03-31': 'Id-Ul-Fitr (Ramadan Eid)',
      '2025-04-10': 'Shri Mahavir Jayanti',
      '2025-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
      '2025-04-18': 'Good Friday',
      '2025-05-01': 'Maharashtra Day',
      '2025-08-15': 'Independence Day',
      '2025-08-27': 'Ganesh Chaturthi',
      '2025-10-02': 'Mahatma Gandhi Jayanti/Dussehra',
      '2025-10-21': 'Diwali Laxmi Pujan (Muhurat trading session held)',
      '2025-10-22': 'Diwali-Balipratipada',
      '2025-11-05': 'Prakash Gurpurb Sri Guru Nanak Dev',
      '2025-12-25': 'Christmas',
    },
    weekendHolidays: {
      '2025-01-26': 'Republic Day',
      '2025-04-06': 'Shri Ram Navami',
      '2025-06-07': 'Bakri Id',
      '2025-07-06': 'Muharram',
    },
    notes: [
      'Matches the list previously entered from recollection exactly.',
      'Muhurat trading was conducted on 2025-10-21 (a holiday); that special session is not a regular trading day.',
    ],
  },
  2026: {
    year: 2026,
    verification: 'OFFICIAL',
    source:
      'NSE circular NSE/FAOP/71777 (Circular Ref. No. 212/2025), 12 Dec 2025, Futures & Options segment, ' +
      '"Trading holidays for the calendar year 2026", https://nsearchives.nseindia.com/content/circulars/FAOP71777.pdf — read 2026-10-04 ' +
      '(identical to the Capital Market circular NSE/CMTR/71775)',
    holidays: {
      '2026-01-15': 'Special holiday: Maharashtra Municipal Corporation elections (added after the annual list)',
      '2026-01-26': 'Republic Day',
      '2026-03-03': 'Holi',
      '2026-03-26': 'Shri Ram Navami',
      '2026-03-31': 'Shri Mahavir Jayanti',
      '2026-04-03': 'Good Friday',
      '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
      '2026-05-01': 'Maharashtra Day',
      '2026-05-28': 'Bakri Id',
      '2026-06-26': 'Muharram',
      '2026-09-14': 'Ganesh Chaturthi',
      '2026-10-02': 'Mahatma Gandhi Jayanti',
      '2026-10-20': 'Dussehra',
      '2026-11-10': 'Diwali-Balipratipada',
      '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
      '2026-12-25': 'Christmas',
    },
    weekendHolidays: {
      '2026-02-15': 'Mahashivratri',
      '2026-03-21': 'Id-Ul-Fitr (Ramadan Eid)',
      '2026-08-15': 'Independence Day',
      '2026-11-08': 'Diwali Laxmi Pujan (Muhurat trading session; timings notified separately)',
    },
    notes: [
      'F&O circular NSE/FAOP/71777, Capital Market circular NSE/CMTR/71775 and the commodity circular NSE/COM/71784 ' +
        '(morning session) all list these same 15 weekdays.',
      '2026-01-15 was added on 2026-01-09 (NSE circular NSE/CD/72233, currency segment; reported as an equity and ' +
        'derivatives closure on 2026-01-12) and is confirmed for F&O by the absence of an F&O bhavcopy for that date. ' +
        'Annual lists can change: cross-check with bhavcopy availability.',
      'Settlement holidays (NSE Clearing NCL/CMPT/71923) differ and are not modelled here.',
      'Muhurat trading on Sunday 2026-11-08 is a special session and is not represented as a trading day.',
    ],
  },
});

function yearOf(dateIso: string): number {
  return Number(dateIso.slice(0, 4));
}

/** True if the date is a listed NSE weekday trading holiday. */
export function isNseTradingHoliday(dateIso: string): boolean {
  return YEARS[yearOf(dateIso)]?.holidays[dateIso] !== undefined;
}

/** Description of the holiday, or null. */
export function nseHolidayName(dateIso: string): string | null {
  return YEARS[yearOf(dateIso)]?.holidays[dateIso] ?? null;
}

/** Verification status of the holiday data for a year. */
export function holidayDataStatus(year: number): { verification: HolidayVerification; source: string } {
  const y = YEARS[year];
  return y
    ? { verification: y.verification, source: y.source }
    : { verification: 'UNKNOWN', source: `No holiday list recorded for ${year}; weekdays are assumed to be trading days.` };
}

/**
 * Special (Muhurat) trading sessions held on a holiday or weekend. NSE publishes an F&O bhavcopy for
 * them, so they must be downloaded for a complete dataset. Whether a strategy may trade in them is a
 * separate policy question (docs/FOUNDATION_AUDIT.md F14).
 */
export const SPECIAL_SESSIONS: Readonly<Record<string, string>> = Object.freeze({
  '2024-11-01': 'Muhurat trading (Diwali), bhavcopy published',
  '2025-10-21': 'Muhurat trading (Diwali), bhavcopy published',
  '2026-11-08': 'Muhurat trading (Diwali, Sunday), timings notified separately',
});

export function isSpecialSession(dateIso: string): boolean {
  return SPECIAL_SESSIONS[dateIso] !== undefined;
}

/**
 * Should a bhavcopy exist for this date? Regular weekdays that are not official holidays, plus
 * special sessions. Years without an official list keep every weekday (download and let NSE answer).
 */
export function expectBhavcopy(dateIso: string): boolean {
  if (isSpecialSession(dateIso)) return true;
  const dow = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !(isNseTradingHoliday(dateIso) && holidayDataStatus(yearOf(dateIso)).verification === 'OFFICIAL');
}

/** Sorted weekday holidays for a year (empty if unknown). */
export function nseHolidaysForYear(year: number): string[] {
  return Object.keys(YEARS[year]?.holidays ?? {}).sort();
}
