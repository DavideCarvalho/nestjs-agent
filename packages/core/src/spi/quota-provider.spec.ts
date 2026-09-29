import { describe, expect, it } from 'vitest';
import { exhaustedWindow, quotaPeriodRange } from './quota-provider.js';

describe('quotaPeriodRange', () => {
  it('spans the UTC day and resets at the next midnight', () => {
    expect(quotaPeriodRange('day', new Date('2026-03-31T23:59:00Z'))).toEqual({
      fromDay: '2026-03-31',
      toDay: '2026-03-31',
      resetsAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('spans the UTC month, across a year end', () => {
    expect(quotaPeriodRange('month', new Date('2026-12-15T10:00:00Z'))).toEqual({
      fromDay: '2026-12-01',
      toDay: '2026-12-31',
      resetsAt: '2027-01-01T00:00:00.000Z',
    });
    expect(quotaPeriodRange('month', new Date('2028-02-10T00:00:00Z')).toDay).toBe('2028-02-29');
  });
});

describe('exhaustedWindow', () => {
  it('names the first window whose token or spend ceiling is reached', () => {
    expect(
      exhaustedWindow([
        { period: 'day', usedTokens: 10, limitTokens: 100, usedUsd: 0 },
        { period: 'month', usedTokens: 10, usedUsd: 5, limitUsd: 5 },
      ]),
    ).toEqual({ period: 'month', reason: 'Monthly spend limit reached' });
    expect(
      exhaustedWindow([{ period: 'day', usedTokens: 100, limitTokens: 100, usedUsd: 0 }]),
    ).toEqual({
      period: 'day',
      reason: 'Daily token limit reached',
    });
  });

  it('never blocks a window without ceilings', () => {
    expect(exhaustedWindow([{ period: 'day', usedTokens: 1e9, usedUsd: 1e9 }])).toBeUndefined();
  });
});
