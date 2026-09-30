// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient, AgentHttpError } from './client.js';
import { useAgentChat } from './use-agent-chat.js';

/** A server that refuses every request the way a NestJS backend does, with a JSON body. */
function refusing(status: number, body: object) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe('useAgentChat — what the server said reaches the hooks', () => {
  it('a refused send surfaces as chat.error with the status, code and message', async () => {
    const fetchMock = refusing(429, {
      code: 'quota_exceeded',
      period: 'day',
      message: 'Daily AI budget used up',
    });
    const backend = new AgentClient({ fetch: fetchMock });
    const { result } = renderHook(() => useAgentChat({ backend, quota: false }));

    await act(async () => {
      await result.current.sendMessage({ text: 'hi' }).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(AgentHttpError));
    expect(result.current.error).toMatchObject({
      status: 429,
      code: 'quota_exceeded',
      message: 'Daily AI budget used up',
    });
  });

  it('a refused decision rejects with the server message', async () => {
    const backend = new AgentClient({
      fetch: refusing(403, { message: 'Only an admin can approve this', code: 'not_approver' }),
    });
    const { result } = renderHook(() => useAgentChat({ backend, quota: false }));

    await expect(result.current.approve({ toolCallId: 'c1' })).rejects.toMatchObject({
      status: 403,
      code: 'not_approver',
      message: 'Only an admin can approve this',
    });
  });

  it("a refused upload shows the server's message on the staged file", async () => {
    const backend = new AgentClient({
      fetch: refusing(415, { message: 'Executables are not allowed', code: 'type_refused' }),
    });
    const { result } = renderHook(() => useAgentChat({ backend, quota: false }));

    act(() => result.current.composer.files.add([new File(['x'], 'a.png', { type: 'image/png' })]));

    await waitFor(() =>
      expect(result.current.composer.files.items[0]).toMatchObject({
        status: 'error',
        error: 'Executables are not allowed',
      }),
    );
  });
});
