// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient } from './client.js';
import { useAgentChat } from './use-agent-chat.js';

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const frames = [
    'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'event: done\ndata: {}\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, statusText: 'OK' });
}

describe('useAgentChat — pushed UI, title, approval metadata (through the real AI SDK)', () => {
  it('stores ui and approval parts, fires onData/onTitle, and puts the call in the native approval state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        { kind: 'step-start' },
        { kind: 'text', text: 'Drafted it.' },
        { kind: 'ui', id: 'ui-1', component: 'email-preview', props: { subject: 'Hi' } },
        { kind: 'title', title: 'Customer follow-up' },
        {
          kind: 'tool-input-available',
          id: 'call-1',
          name: 'sendEmail',
          input: { to: 'a@b.c' },
          toolKind: 'action',
        },
        { kind: 'approval-requested', id: 'call-1', approver: 'admin', reason: 'External email' },
        { kind: 'step-finish' },
      ]),
    );
    const onData = vi.fn();
    const onTitle = vi.fn();

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-1',
        backend: new AgentClient({ fetch: fetchMock }),
        onData,
        onTitle,
      }),
    );
    await act(async () => {
      await result.current.sendMessage({ text: 'email them' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const parts = result.current.messages.at(-1)?.parts ?? [];
    expect(parts.map((part) => part.type)).toEqual([
      'step-start',
      'text',
      'data-ui',
      'tool-sendEmail',
      'data-approval-requested',
    ]);
    const tool = parts.find((part) => part.type === 'tool-sendEmail') as {
      state: string;
      approval?: { id: string };
    };
    expect(tool.state).toBe('approval-requested');
    expect(tool.approval).toEqual({ id: 'call-1' });

    expect(onTitle).toHaveBeenCalledWith('Customer follow-up');
    expect(onData.mock.calls.map(([part]) => part.type)).toEqual([
      'data-ui',
      'data-title',
      'data-approval-requested',
    ]);
  });
});
