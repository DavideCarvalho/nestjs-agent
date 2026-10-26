import { AgentStreamError } from '@dudousxd/nestjs-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InProcessTokenStreamSink } from './in-process-sink.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How many runs the sink still holds — the leak these tests pin down has no public surface. */
function held(sink: InProcessTokenStreamSink): number {
  const internals = sink as unknown as {
    runs: Map<string, unknown>;
    waiting: Map<string, unknown>;
  };
  return internals.runs.size + (internals.waiting?.size ?? 0);
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) out.push(decoder.decode(chunk));
  return out;
}

/** `promise`, or `'pending'` if it has not settled within a few macrotasks. */
async function settledSoon<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
}

describe('InProcessTokenStreamSink', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays an ended run, then lets go of it after a grace period', async () => {
    vi.useFakeTimers();
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-1');
    writer.write(encoder.encode('a'));
    writer.write(encoder.encode('b'));
    writer.end();
    expect(await collect(sink.subscribe('run-1'))).toEqual(['a', 'b']);
    expect(held(sink)).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(held(sink)).toBe(0);
  });

  it('drops a run that stopped writing without ending, and ends its subscribers', async () => {
    vi.useFakeTimers();
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-crashed');
    writer.write(encoder.encode('partial'));
    const following = collect(sink.subscribe('run-crashed'));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // Still writing within the window keeps it.
    writer.write(encoder.encode(' more'));
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(held(sink)).toBe(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(held(sink)).toBe(0);
    expect(await following).toEqual(['partial', ' more']);
  });

  it('starts a fresh buffer for a run that writes again after going quiet past the TTL', async () => {
    vi.useFakeTimers();
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-parked');
    writer.write(encoder.encode('before'));
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(held(sink)).toBe(0);
    const following = collect(sink.subscribe('run-parked'));
    writer.write(encoder.encode('after'));
    writer.end();
    expect(await following).toEqual(['after']);
  });

  it('holds nothing for a run nobody opens once its subscriber goes', async () => {
    const sink = new InProcessTokenStreamSink();
    const controller = new AbortController();
    const following = collect(sink.subscribe('run-unknown', { signal: controller.signal }));
    expect(await settledSoon(following)).toBe('pending');
    controller.abort();
    expect(await settledSoon(following)).toEqual([]);
    expect(held(sink)).toBe(0);
  });

  it('follows a run a subscriber attached to before it was opened', async () => {
    const sink = new InProcessTokenStreamSink();
    const following = collect(sink.subscribe('run-early'));
    await settledSoon(following);
    const writer = sink.open('run-early');
    writer.write(encoder.encode('hi'));
    writer.end();
    expect(await following).toEqual(['hi']);
  });

  it('stops following a live run as soon as the subscriber aborts', async () => {
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-live');
    writer.write(encoder.encode('x'));
    const controller = new AbortController();
    const following = collect(sink.subscribe('run-live', { signal: controller.signal }));
    expect(await settledSoon(following)).toBe('pending');
    controller.abort();
    expect(await settledSoon(following)).toEqual(['x']);
  });

  it('raises a failed run after replaying it', async () => {
    const sink = new InProcessTokenStreamSink();
    const writer = sink.open('run-failed');
    writer.write(encoder.encode('partial'));
    writer.fail({ code: 'run_failed', message: 'boom' });
    await expect(collect(sink.subscribe('run-failed'))).rejects.toBeInstanceOf(AgentStreamError);
  });
});
