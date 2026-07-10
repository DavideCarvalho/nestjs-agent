// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentChat } from './use-agent-chat.js';

// EXACT frames captured off the live SSE wire (process 28354, port 3002) for
// "How many active users do we have today?" — executeSql then renderResult.
const WIRE_FRAMES = [
  'event: meta\ndata: {"runId":"run-x","threadId":"thr-x"}\n\n',
  'data: {"kind":"step-start"}\n\n',
  'data: {"kind":"text","text":"I\'ll query the user table to count the active users."}\n\n',
  'data: {"kind":"tool-input-start","id":"tc1","name":"executeSql"}\n\n',
  'data: {"kind":"tool-input-delta","id":"tc1","delta":"{\\"query\\""}\n\n',
  'data: {"kind":"tool-input-delta","id":"tc1","delta":": \\"SELECT COUNT(*) as active_users FROM user\\", \\"summary\\": \\"Counting active users\\"}"}\n\n',
  'data: {"kind":"tool-input-available","id":"tc1","name":"executeSql","input":{"query":"SELECT COUNT(*) as active_users FROM user","summary":"Counting active users"}}\n\n',
  'data: {"kind":"tool-output","id":"tc1","output":{"rows":[{"active_users":19}]}}\n\n',
  'data: {"kind":"step-finish"}\n\n',
  'data: {"kind":"step-start"}\n\n',
  'data: {"kind":"tool-input-start","id":"tc2","name":"renderResult"}\n\n',
  'data: {"kind":"tool-input-delta","id":"tc2","delta":"{\\"type\\": \\"Stat\\", \\"props\\": {\\"value\\":19,\\"label\\":\\"Active Users Today\\",\\"tone\\":\\"info\\"}, \\"children\\": []}"}\n\n',
  'data: {"kind":"tool-input-available","id":"tc2","name":"renderResult","input":{"type":"Stat","props":{"value":19,"label":"Active Users Today","tone":"info"},"children":[]}}\n\n',
  'data: {"kind":"tool-output","id":"tc2","output":{"rendered":true}}\n\n',
  'data: {"kind":"step-finish"}\n\n',
  'event: done\ndata: {}\n\n',
];

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: 'OK', body, headers: new Headers() };
}

function jsonResponse() {
  return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), text: async () => '' };
}

describe('repro real frames', () => {
  it('builds tool parts (not text) from the captured wire', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/agent/chat')) return sseResponse(WIRE_FRAMES);
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({ threadId: 'thr-x', fetch: fetchMock as unknown as typeof fetch }),
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'How many active users do we have today?' });
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    // Dump the actual parts so we can SEE what flip's renderer receives.
    // eslint-disable-next-line no-console
    console.log(
      'ASSISTANT PARTS:',
      JSON.stringify(
        (assistant?.parts ?? []).map((p) => ({
          type: p.type,
          // @ts-expect-error probe
          state: p.state,
          // @ts-expect-error probe
          input: p.input,
          // @ts-expect-error probe
          text: p.text,
        })),
        null,
        2,
      ),
    );

    const types = (assistant?.parts ?? []).map((p) => p.type);
    expect(types).toContain('tool-executeSql');
    expect(types).toContain('tool-renderResult');
  });
});
