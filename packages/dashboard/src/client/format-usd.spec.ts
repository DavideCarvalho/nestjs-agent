import { describe, expect, it } from 'vitest';
import { formatCount, formatDurationMs, formatPercent, formatUsd } from './format-usd';

describe('formatUsd', () => {
  it('formats plain dollars to two decimals', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('collapses sub-cent amounts to <$0.01', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
  });

  it('uses k / M suffixes for large amounts', () => {
    expect(formatUsd(1500)).toBe('$1.50k');
    expect(formatUsd(2_400_000)).toBe('$2.40M');
  });

  it('guards non-finite input', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('formatCount', () => {
  it('rounds small counts and abbreviates large ones', () => {
    expect(formatCount(842)).toBe('842');
    expect(formatCount(1250)).toBe('1.3k');
    expect(formatCount(3_400_000)).toBe('3.4M');
    expect(formatCount(1_100_000_000)).toBe('1.1B');
  });
});

describe('formatPercent', () => {
  it('renders a ratio as an integer percent', () => {
    expect(formatPercent(0.1234)).toBe('12%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});

describe('formatDurationMs', () => {
  it('renders sub-second durations in ms', () => {
    expect(formatDurationMs(420)).toBe('420ms');
  });

  it('renders sub-minute durations in seconds', () => {
    expect(formatDurationMs(1800)).toBe('1.8s');
  });

  it('renders minute-scale durations as `Nm Ns`', () => {
    expect(formatDurationMs(125_000)).toBe('2m 5s');
  });

  it('renders `—` for null (no data) or non-finite input', () => {
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(Number.NaN)).toBe('—');
  });
});
