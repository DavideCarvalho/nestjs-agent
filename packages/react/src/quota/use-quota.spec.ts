// @vitest-environment jsdom
import type { QuotaReport } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../backend.js';
import { AgentClient } from '../client.js';
import { notifyThreads } from '../threads/threads-events.js';
import { QuotaBlockedError, useAgentChat } from '../use-agent-chat.js';
import { useQuota } from './use-quota.js';

const OPEN: QuotaReport = {
  windows: [
    { period: 'day', usedTokens: 10, limitTokens: 100, usedUsd: 0.1 },
    { period: 'month', usedTokens: 90, usedUsd: 4, limitUsd: 5 },
  ],
};
const BLOCKED: QuotaReport = {
  windows: [{ period: 'month', usedTokens: 90, usedUsd: 5, limitUsd: 5 }],
  blocked: { period: 'month', reason: 'Monthly AI budget reached' },
};

function backend(getQuota: () => Promise<QuotaReport>): AgentBackend {
  return {
    openChatStream: vi.fn(async () => {
      throw new Error('should not be called');
    }),
    resumeChatStream: async () => null,
    cancelStream: async () => ({}),
    listThreads: async () => [],
    getThread: async () => {
      throw new Error('unused');
    },
    updateThread: async () => ({}),
    deleteThread: async () => undefined,
    getQuota: vi.fn(getQuota),
  };
}

describe('useQuota', () => {
  it('splits the report into windows and re-reads when a chat settles a run', async () => {
    let report = OPEN;
    const api = backend(async () => report);
    const { result } = renderHook(() => useQuota({ backend: api }));
    await waitFor(() => expect(result.current.day?.usedTokens).toBe(10));
    expect(result.current.month?.limitUsd).toBe(5);
    expect(result.current.blocked).toBeNull();

    report = BLOCKED;
    act(() => notifyThreads(api, { type: 'changed' }));
    await waitFor(() => expect(result.current.blocked?.period).toBe('month'));
    expect(api.getQuota).toHaveBeenCalledTimes(2);
  });
});

describe('useAgentChat({ blocked })', () => {
  it('refuses to send while a window is exhausted, without calling the server', async () => {
    const api = backend(async () => BLOCKED);
    const { result } = renderHook(() =>
      useAgentChat({ backend: api, blocked: BLOCKED.blocked ?? null }),
    );
    await act(async () => {
      await expect(result.current.sendMessage({ text: 'hi' })).rejects.toBeInstanceOf(
        QuotaBlockedError,
      );
    });
    expect(api.openChatStream).not.toHaveBeenCalled();
    expect(() => result.current.regenerate()).toThrow('Monthly AI budget reached');
  });
});

describe('AgentClient.getQuota', () => {
  it('asks GET /agent/quota', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(OPEN) };
    }) as unknown as typeof globalThis.fetch;
    expect(await new AgentClient({ fetch }).getQuota()).toEqual(OPEN);
    expect(urls).toEqual(['/agent/quota']);
  });
});
