// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentChat } from './use-agent-chat.js';

// An authored intake asks BEFORE the turn's first model call, so the run's very first frames are
// the question set and — once a human settles it — that set's own tool output. Nothing ever
// announced the tool call, which is what used to make the settlement an orphan.
const INTAKE_FRAMES = [
  'event: meta\ndata: {"runId":"run-i","threadId":"thr-i"}\n\n',
  'data: {"kind":"elicitation","id":"intake-run-i","request":{"id":"intake-run-i","source":"intake","preamble":"A few questions before I start.","questions":[{"id":"scope","prompt":"How much should I cover?","options":[{"value":"file","label":"This file","hotkey":"a"},{"value":"module","label":"The whole module","hotkey":"b"}],"defaults":["module"]}]}}\n\n',
  'data: {"kind":"tool-output","id":"intake-run-i","output":{"answers":{"scope":["file"]},"skipped":false,"defaulted":[],"summary":"The user answered:\\nHow much should I cover? → This file"}}\n\n',
  'data: {"kind":"step-start"}\n\n',
  'data: {"kind":"text","text":"Refactoring just this file, then."}\n\n',
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

describe('repro intake frames', () => {
  it('renders the settled question set and the answer that follows it', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/agent/chat')) return sseResponse(INTAKE_FRAMES);
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({ threadId: 'thr-i', fetch: fetchMock as unknown as typeof fetch }),
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'refactor this' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const assistant = result.current.messages.find((message) => message.role === 'assistant');
    // The whole streamed message used to vanish here — the AI SDK rejects a settlement for a part
    // it never saw open, and it fails without a console error, so the panel just renders nothing.
    expect(assistant).toBeDefined();

    const ask = (assistant?.parts ?? []).find((part) => part.type === 'tool-ask') as
      | { state: string; input: { questions: { id: string }[] }; output: { answers: unknown } }
      | undefined;
    expect(ask).toBeDefined();
    expect(ask?.state).toBe('output-available');
    expect(ask?.input.questions.map((question) => question.id)).toEqual(['scope']);
    expect(ask?.output.answers).toEqual({ scope: ['file'] });

    const texts = (assistant?.parts ?? [])
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text);
    expect(texts).toEqual(['Refactoring just this file, then.']);
  });
});
