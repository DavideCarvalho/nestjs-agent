import { describe, expect, it } from 'vitest';
import { formatDayLabel, formatDayTick } from './format-day';

describe('formatDayTick', () => {
  it('renders a calendar day as a short month/day tick', () => {
    expect(formatDayTick('2026-07-12')).toBe('Jul 12');
    expect(formatDayTick('2026-01-01')).toBe('Jan 1');
    expect(formatDayTick('2026-12-31')).toBe('Dec 31');
  });

  it('never renders a day other than the one written in the string', () => {
    // The drift this function exists to avoid: `new Date('2026-07-12')` is UTC midnight, which every
    // negative-offset zone renders as Jul 11. The label must always agree with the literal digits.
    for (const day of ['2026-01-01', '2026-03-08', '2026-07-12', '2026-12-31']) {
      expect(formatDayTick(day).endsWith(` ${Number(day.slice(8, 10))}`)).toBe(true);
    }
  });

  it('passes through anything that is not a calendar day', () => {
    expect(formatDayTick('')).toBe('');
    expect(formatDayTick('not-a-day')).toBe('not-a-day');
    expect(formatDayTick('2026-13-01')).toBe('2026-13-01');
  });
});

describe('formatDayLabel', () => {
  it('includes the year for tooltips and captions', () => {
    expect(formatDayLabel('2026-07-12')).toBe('Jul 12, 2026');
  });

  it('passes through anything that is not a calendar day', () => {
    expect(formatDayLabel('')).toBe('');
    expect(formatDayLabel('2026-00-09')).toBe('2026-00-09');
  });
});
