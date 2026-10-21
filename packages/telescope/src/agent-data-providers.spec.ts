import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import {
  type AgentEntryContent,
  agentRunFailureCodesProvider,
  agentRunsCancelledProvider,
  agentRunsTtftDistributionProvider,
  agentToolStatusProvider,
  toFailureCodeSegments,
  toTtftDistribution,
} from './agent-data-providers.js';

function entries(...contents: AgentEntryContent[]) {
  return contents.map((content) => ({ content }));
}

function contextWith(data: { content: AgentEntryContent }[]): ExtensionContext {
  const storage = { get: async () => ({ data }) };
  return {
    config: {},
    moduleRef: {
      get: (token: unknown) => {
        if (token !== TELESCOPE_STORAGE) throw new Error('unexpected token');
        return storage;
      },
    },
  } as unknown as ExtensionContext;
}

describe('toTtftDistribution', () => {
  it('buckets top-level runs by ttftMs and reports p50/p95 of the raw samples', () => {
    const result = toTtftDistribution(
      entries(
        { event: 'run.finished', runId: 'r1', ttftMs: 120 },
        { event: 'run.finished', runId: 'r2', ttftMs: 700 },
        { event: 'run.finished', runId: 'r3', ttftMs: 3_000 },
        { event: 'run.finished', runId: 'r4', ttftMs: 20_000 },
        // A delegated child streams into its parent's turn — not a first token anyone waited for.
        { event: 'run.finished', runId: 'c1', ttftMs: 50, parentRunId: 'r1' },
        // A run that streamed no text carries no ttftMs — left out, never counted as 0.
        { event: 'run.finished', runId: 'r5' },
        { event: 'run.started', runId: 'r6', ttftMs: 1 },
      ),
    );
    expect(result.buckets.map((bucket) => bucket.count)).toEqual([1, 0, 1, 0, 1, 0, 0, 1]);
    expect(result.buckets[0]?.label).toBe('0–250ms');
    expect(result.buckets.at(-1)?.label).toBe('≥16000ms');
    expect(result.p50).toBe(700);
    expect(result.p95).toBe(20_000);
  });

  it('has empty buckets and no markers when nothing recorded a first token', () => {
    const result = toTtftDistribution([]);
    expect(result.buckets.every((bucket) => bucket.count === 0)).toBe(true);
    expect(result).not.toHaveProperty('p50');
    expect(result).not.toHaveProperty('p95');
  });
});

describe('toFailureCodeSegments', () => {
  it('counts run.failed entries by code, largest first, ignoring cancels', () => {
    expect(
      toFailureCodeSegments(
        entries(
          { event: 'run.failed', code: 'run_failed' },
          { event: 'run.failed', code: 'quota_exceeded' },
          { event: 'run.failed', code: 'quota_exceeded' },
          { event: 'run.failed' },
          { event: 'run.cancelled' },
        ),
      ),
    ).toEqual([
      { label: 'quota_exceeded', value: 2 },
      { label: 'run_failed', value: 1 },
      { label: 'unknown', value: 1 },
    ]);
  });
});

describe('agent data providers', () => {
  const ctx = contextWith(
    entries(
      { event: 'run.finished', runId: 'r1', ttftMs: 300 },
      { event: 'run.failed', runId: 'r2', code: 'model_no_output' },
      { event: 'run.cancelled', runId: 'r3' },
      { event: 'run.cancelled', runId: 'r4' },
      { event: 'tool-call', runId: 'r1', status: 'executed' },
      // The same outcome re-published by a durable replay — must not count twice.
      { event: 'tool-call', runId: 'r1', status: 'executed', replayed: true },
      { event: 'tool-call', runId: 'r1', status: 'failed' },
    ),
  );

  it('resolves the TTFT histogram from run.finished entries', async () => {
    const result = (await agentRunsTtftDistributionProvider().resolve({}, ctx)) as {
      p50?: number;
    };
    expect(result.p50).toBe(300);
  });

  it('resolves failures by code and the cancelled count separately', async () => {
    await expect(agentRunFailureCodesProvider().resolve({}, ctx)).resolves.toEqual({
      segments: [{ label: 'model_no_output', value: 1 }],
    });
    await expect(agentRunsCancelledProvider().resolve({}, ctx)).resolves.toEqual({ value: 2 });
  });

  it('skips replayed tool-call re-publications in the status breakdown', async () => {
    await expect(agentToolStatusProvider().resolve({}, ctx)).resolves.toEqual({
      segments: [
        { label: 'executed', value: 1 },
        { label: 'failed', value: 1 },
      ],
    });
  });
});
