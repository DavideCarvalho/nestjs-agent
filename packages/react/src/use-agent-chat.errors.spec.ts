// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient, AgentHttpError } from './client.js';
import { isRunNotActiveError } from './run-errors.js';
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

  it('a decision on a turn that is over is recognisable as run_not_active', async () => {
    const backend = new AgentClient({
      fetch: refusing(409, {
        statusCode: 409,
        code: 'run_not_active',
        message: 'This request is no longer waiting for an answer',
      }),
    });
    const { result } = renderHook(() => useAgentChat({ backend, quota: false }));

    const refused = await result.current.approve({ toolCallId: 'c1' }).catch((error) => error);
    expect(isRunNotActiveError(refused)).toBe(true);
    expect(
      isRunNotActiveError(await result.current.answer({ toolCallId: 'c1' }).catch((e) => e)),
    ).toBe(true);
    expect(isRunNotActiveError(new Error('nope'))).toBe(false);
  });

  it('a failed run surfaces its code on chat.runError, and the next send clears it', async () => {
    const sse = (frames: string[]) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }),
        { headers: { 'x-agent-run-id': 'r1', 'x-agent-thread-id': 't1' } },
      );
    };
    let sends = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/chat')) {
        sends += 1;
        return sends === 1
          ? sse([
              'event: meta\ndata: {"runId":"r1","threadId":"t1"}\n\n',
              'event: error\ndata: {"code":"replay_diverged","message":"The assistant could not finish this answer. Please try again."}\n\n',
            ])
          : sse([
              'event: meta\ndata: {"runId":"r2","threadId":"t1"}\n\n',
              'data: {"kind":"text","text":"hi"}\n\n',
              'event: done\ndata: {}\n\n',
            ]);
      }
      return Response.json({ id: 't1', messages: [], activeRunId: null });
    });
    const backend = new AgentClient({ fetch: fetchMock });
    const { result } = renderHook(() => useAgentChat({ backend, quota: false, reconnect: false }));
    expect(result.current.runError).toBeNull();

    await act(async () => {
      await result.current.sendMessage({ text: 'hi' }).catch(() => undefined);
    });
    await waitFor(() =>
      expect(result.current.runError).toEqual({
        code: 'replay_diverged',
        message: 'The assistant could not finish this answer. Please try again.',
        runId: 'r1',
      }),
    );
    expect(result.current.error?.message).toBe(
      'The assistant could not finish this answer. Please try again.',
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'again' }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.runError).toBeNull());
  });
});
