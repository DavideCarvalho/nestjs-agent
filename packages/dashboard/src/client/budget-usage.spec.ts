import { describe, expect, it } from 'vitest';
import type { ActorSpendRow } from './agent-client';
import { joinBudgets } from './budget-usage';

function actor(over: Partial<ActorSpendRow> = {}): ActorSpendRow {
  return { actorRef: 'user:1', requests: 0, totalTokens: 0, costUsd: 0, actorLabel: null, ...over };
}

describe('joinBudgets', () => {
  it('leaves an actor without a configured limit budget-less', () => {
    const [row] = joinBudgets([actor({ totalTokens: 100 })]);
    expect(row?.limitTokens).toBeUndefined();
    expect(row?.usageRatio).toBeUndefined();
    expect(row?.overBudget).toBe(false);
  });

  it('computes usage ratio against a known limit', () => {
    const [row] = joinBudgets([actor({ actorRef: 'user:1', totalTokens: 250 })], {
      'user:1': 1000,
    });
    expect(row?.limitTokens).toBe(1000);
    expect(row?.usageRatio).toBeCloseTo(0.25);
    expect(row?.overBudget).toBe(false);
  });

  it('flags an actor at or over its limit', () => {
    const [row] = joinBudgets([actor({ actorRef: 'user:1', totalTokens: 1200 })], {
      'user:1': 1000,
    });
    expect(row?.usageRatio).toBeCloseTo(1.2);
    expect(row?.overBudget).toBe(true);
  });

  it('sorts by cost descending', () => {
    const rows = joinBudgets([
      actor({ actorRef: 'a', costUsd: 1 }),
      actor({ actorRef: 'b', costUsd: 5 }),
    ]);
    expect(rows.map((r) => r.actorRef)).toEqual(['b', 'a']);
  });

  it('ignores a zero/negative configured limit', () => {
    const [row] = joinBudgets([actor({ actorRef: 'user:1', totalTokens: 10 })], { 'user:1': 0 });
    expect(row?.limitTokens).toBeUndefined();
  });
});
