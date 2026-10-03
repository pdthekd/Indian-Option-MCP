import { describe, it, expect } from 'vitest';
import { isNseTradingHoliday, holidayDataStatus, nseHolidaysForYear, nseHolidayName } from '../data/constants/holidays.js';
import { getNextExpiry, isTradingDay } from '../data/constants/expiry-calendar.js';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);

describe('NSE 2026 trading holidays (official circular NSE/CMTR/71775)', () => {
  it('has exactly the 15 weekday holidays from the circular', () => {
    expect(nseHolidaysForYear(2026)).toEqual([
      '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
      '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
    ]);
    expect(holidayDataStatus(2026).verification).toBe('OFFICIAL');
    expect(holidayDataStatus(2026).source).toContain('NSE/CMTR/71775');
  });
  it('no longer contains dates from the old, wrong lists', () => {
    for (const wrong of ['2026-03-10', '2026-03-17', '2026-04-02', '2026-05-25', '2026-11-09', '2026-11-27', '2026-02-17', '2026-08-25'])
      expect(isNseTradingHoliday(wrong), wrong).toBe(false);
  });
  it('reports unknown years honestly', () => {
    expect(holidayDataStatus(2027).verification).toBe('UNKNOWN');
    expect(holidayDataStatus(2025).verification).toBe('UNVERIFIED');
  });
  it('2025-05-12 is a trading day (account holder traded that day)', () => {
    expect(isTradingDay(d('2025-05-12'))).toBe(true);
  });
  it('names holidays', () => {
    expect(nseHolidayName('2026-10-20')).toBe('Dussehra');
  });
});

describe('Tuesday holidays move NIFTY expiries to Monday', () => {
  it.each([
    ['2026-02-28', '2026-03-02'], // Holi on Tue 3 Mar
    ['2026-03-27', '2026-03-30'], // Mahavir Jayanti on Tue 31 Mar
    ['2026-04-10', '2026-04-13'], // Ambedkar Jayanti on Tue 14 Apr
    ['2026-10-14', '2026-10-19'], // Dussehra on Tue 20 Oct
    ['2026-11-05', '2026-11-09'], // Balipratipada on Tue 10 Nov
    ['2026-11-18', '2026-11-23'], // Guru Nanak Jayanti on Tue 24 Nov
  ])('weekly from %s → %s', (from, expected) => {
    expect(ymd(getNextExpiry('NIFTY', true, d(from)))).toBe(expected);
  });
  it('November monthly (last Tuesday 24 Nov is a holiday) → Monday 23 Nov', () => {
    expect(ymd(getNextExpiry('BANKNIFTY', false, d('2026-11-01')))).toBe('2026-11-23');
  });
  it('March monthly (last Tuesday 31 Mar is a holiday) → Monday 30 Mar', () => {
    expect(ymd(getNextExpiry('NIFTY', false, d('2026-03-01')))).toBe('2026-03-30');
  });
});
