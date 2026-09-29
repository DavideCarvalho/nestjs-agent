// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, readReasoningMs, useElapsed } from './timing.js';

describe('formatElapsed', () => {
  it.each([
    [0, '<1s'],
    [999, '<1s'],
    [-5, '<1s'],
    [Number.NaN, '<1s'],
    [4_200, '4s'],
    [65_000, '1m 5s'],
    [120_000, '2m'],
    [3_720_000, '1h 2m'],
    [3_600_000, '1h'],
  ])('%s ms → %s', (ms, label) => {
    expect(formatElapsed(ms)).toBe(label);
  });
});

describe('readReasoningMs', () => {
  it('reads the stamped duration and ignores anything else', () => {
    expect(readReasoningMs({ providerMetadata: { agent: { reasoningMs: 1200 } } })).toBe(1200);
    expect(readReasoningMs({ providerMetadata: { agent: { reasoningMs: 'x' } } })).toBeNull();
    expect(readReasoningMs({ providerMetadata: { anthropic: {} } })).toBeNull();
    expect(readReasoningMs({})).toBeNull();
  });
});

describe('useElapsed', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks while running and freezes at the final value once stopped', () => {
    const { result, rerender } = renderHook(
      ({ running }) => useElapsed(running, { intervalMs: 500, now: () => now }),
      { initialProps: { running: false } },
    );
    expect(result.current).toBe(0);

    rerender({ running: true });
    act(() => {
      now += 1_000;
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(1_000);

    act(() => {
      now += 700;
    });
    rerender({ running: false });
    expect(result.current).toBe(1_700);

    act(() => {
      now += 5_000;
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(1_700);
  });
});
