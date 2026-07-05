import { describe, expect, it } from 'vitest';
import { defaultRange, isIsoDay, rangeDays, utcDay } from './default-range';

const NOON_2026_07_05 = Date.parse('2026-07-05T12:00:00Z');

describe('utcDay', () => {
  it('returns the current UTC day for 0', () => {
    expect(utcDay(0, NOON_2026_07_05)).toBe('2026-07-05');
  });

  it('walks back whole days', () => {
    expect(utcDay(5, NOON_2026_07_05)).toBe('2026-06-30');
  });
});

describe('defaultRange', () => {
  it('opens on an inclusive 30-day window ending today', () => {
    expect(defaultRange(30, NOON_2026_07_05)).toEqual({
      fromDay: '2026-06-06',
      toDay: '2026-07-05',
    });
  });
});

describe('isIsoDay', () => {
  it('accepts YYYY-MM-DD and rejects junk', () => {
    expect(isIsoDay('2026-07-05')).toBe(true);
    expect(isIsoDay('2026/07/05')).toBe(false);
    expect(isIsoDay('nope')).toBe(false);
  });
});

describe('rangeDays', () => {
  it('counts both endpoints', () => {
    expect(rangeDays({ fromDay: '2026-07-01', toDay: '2026-07-05' })).toBe(5);
    expect(rangeDays({ fromDay: '2026-07-05', toDay: '2026-07-05' })).toBe(1);
  });

  it('clamps a reversed range to 1', () => {
    expect(rangeDays({ fromDay: '2026-07-05', toDay: '2026-07-01' })).toBe(1);
  });
});
