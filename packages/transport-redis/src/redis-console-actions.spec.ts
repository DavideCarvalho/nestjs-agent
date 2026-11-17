import type { AgentApprovalPort } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleActionError,
  RedisConsoleActionResponder,
  RedisConsoleApprovalClient,
  type RedisConsoleResponderClient,
} from './redis-console-actions.js';

/** One in-memory Redis: pub/sub delivered asynchronously, plus `SET NX EX`. */
class FakeRedis implements RedisConsoleResponderClient {
  readonly published: Array<{ channel: string; message: string }> = [];
  private readonly subscribers = new Map<string, Set<(message: string) => void>>();
  private readonly keys = new Set<string>();

  async publish(channel: string, message: string): Promise<void> {
    this.published.push({ channel, message });
    for (const handler of this.subscribers.get(channel) ?? []) {
      queueMicrotask(() => handler(message));
    }
  }

  async subscribe(channel: string, onMessage: (message: string) => void) {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(onMessage);
    this.subscribers.set(channel, set);
    return async () => {
      set.delete(onMessage);
    };
  }

  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  listeners(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }
}

function recordingPort(): AgentApprovalPort & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    approve: async (...args) => {
      calls.push(['approve', ...args]);
    },
    reject: async (...args) => {
      calls.push(['reject', ...args]);
    },
  };
}

describe('RedisConsoleApprovalClient + RedisConsoleActionResponder', () => {
  it('executes an approve on the app through its own approval port', async () => {
    const redis = new FakeRedis();
    const port = recordingPort();
    const responder = new RedisConsoleActionResponder(redis, port, { keyPrefix: 'orders' });
    await responder.start();
    const client = new RedisConsoleApprovalClient(redis, { keyPrefix: 'orders' });

    await client.approve('tc-1', { executedByRef: 'user:7', decidedVia: 'console' });
    await client.reject('tc-2', { reason: 'no' });

    expect(port.calls).toEqual([
      ['approve', 'tc-1', { executedByRef: 'user:7', decidedVia: 'console' }],
      ['reject', 'tc-2', { reason: 'no' }],
    ]);
    // The reply subscription is dropped once answered.
    expect(redis.published.filter((p) => p.channel === 'orders:requests')).toHaveLength(2);
    await responder.stop();
    expect(redis.listeners('orders:requests')).toBe(0);
  });

  it("carries the app's error status back to the hub", async () => {
    const redis = new FakeRedis();
    const port = recordingPort();
    port.approve = async () => {
      throw Object.assign(new Error('tool call tc-9 not found'), { getStatus: () => 404 });
    };
    await new RedisConsoleActionResponder(redis, port).start();
    const error = await new RedisConsoleApprovalClient(redis).approve('tc-9').catch((e) => e);
    expect(error).toBeInstanceOf(ConsoleActionError);
    expect(error).toMatchObject({ status: 404, message: 'tool call tc-9 not found' });
  });

  it('answers 500 for an error without a status', async () => {
    const redis = new FakeRedis();
    const port = recordingPort();
    port.reject = async () => {
      throw new Error('boom');
    };
    await new RedisConsoleActionResponder(redis, port).start();
    await expect(new RedisConsoleApprovalClient(redis).reject('tc')).rejects.toMatchObject({
      status: 500,
      message: 'boom',
    });
  });

  it('only one replica executes a request', async () => {
    const redis = new FakeRedis();
    const first = recordingPort();
    const second = recordingPort();
    await new RedisConsoleActionResponder(redis, first).start();
    await new RedisConsoleActionResponder(redis, second).start();
    await new RedisConsoleApprovalClient(redis).approve('tc-1');
    expect(first.calls.length + second.calls.length).toBe(1);
  });

  it('keeps apps apart by prefix', async () => {
    const redis = new FakeRedis();
    const a = recordingPort();
    const b = recordingPort();
    await new RedisConsoleActionResponder(redis, a, { keyPrefix: 'a' }).start();
    await new RedisConsoleActionResponder(redis, b, { keyPrefix: 'b' }).start();
    await new RedisConsoleApprovalClient(redis, { keyPrefix: 'b' }).approve('tc-b');
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([['approve', 'tc-b', {}]]);
  });

  it('fails with 504 when no responder answers', async () => {
    vi.useFakeTimers();
    try {
      const redis = new FakeRedis();
      const pending = new RedisConsoleApprovalClient(redis, { timeoutMs: 50 })
        .approve('tc')
        .catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toMatchObject({ status: 504 });
      const request = JSON.parse(redis.published[0]?.message ?? '{}') as { id: string };
      expect(redis.listeners(`agent:console:reply:${request.id}`)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores malformed requests', async () => {
    const redis = new FakeRedis();
    const port = recordingPort();
    await new RedisConsoleActionResponder(redis, port).start();
    await redis.publish('agent:console:requests', 'not json');
    await redis.publish('agent:console:requests', JSON.stringify({ v: 1, action: 'drop' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.calls).toEqual([]);
    expect(redis.published.filter((p) => p.channel.includes(':reply:'))).toEqual([]);
  });
});
