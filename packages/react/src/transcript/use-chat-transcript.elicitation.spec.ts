// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptElicitationBlock, TranscriptToolBlock } from './model.js';
import { type UseChatTranscriptOptions, useChatTranscript } from './use-chat-transcript.js';

const QUESTIONS = [
  {
    id: 'scope',
    prompt: 'How much should I cover?',
    options: [
      { value: 'file', label: 'This file', hotkey: 'a' },
      { value: 'module', label: 'The whole module', hotkey: 'b' },
    ],
    defaults: ['module'],
  },
  {
    id: 'tests',
    prompt: 'Which tests should I touch?',
    multiple: true,
    options: [
      { value: 'unit', label: 'Unit' },
      { value: 'e2e', label: 'End to end' },
    ],
    defaults: ['unit'],
  },
];

function parked(): UIMessage[] {
  return [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refactor this' }] },
    {
      id: 'm2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-ask',
          toolCallId: 'intake-run-1',
          state: 'input-available',
          input: { preamble: 'A few questions first.', questions: QUESTIONS },
        } as UIMessage['parts'][number],
      ],
    },
  ];
}

function transcript(options: Partial<UseChatTranscriptOptions> = {}) {
  return renderHook(() => useChatTranscript({ messages: parked(), status: 'ready', ...options }));
}

function questionSet(result: { current: ReturnType<typeof useChatTranscript> }) {
  const block = result.current.items.at(-1)?.blocks[0];
  return block as TranscriptElicitationBlock;
}

describe('useChatTranscript — settling a question set', () => {
  it('keeps it a tool card until the host says where an answer goes', () => {
    const { result } = transcript();
    expect(result.current.items.at(-1)?.blocks[0]?.kind).toBe('tools');
  });

  it('holds the picks so a chosen option survives the next render', () => {
    const { result } = transcript({ onAnswer: () => undefined });

    expect(questionSet(result).questions[0]?.selected).toEqual(['module']);
    act(() => questionSet(result).questions[0]?.options[0]?.select());
    expect(questionSet(result).questions[0]?.selected).toEqual(['file']);
    expect(questionSet(result).questions[0]?.isPristine).toBe(false);
    // Untouched questions are still showing what the agent pre-picked.
    expect(questionSet(result).questions[1]?.selected).toEqual(['unit']);
  });

  it('submits only the questions the user touched, so the rest persist as defaulted', async () => {
    const onAnswer = vi.fn();
    const { result } = transcript({ onAnswer });

    act(() => questionSet(result).questions[0]?.options[0]?.select());
    act(() => questionSet(result).answer.run());

    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer).toHaveBeenCalledWith('intake-run-1', { scope: ['file'] });
  });

  it("keeps one set's picks out of another set's submission", async () => {
    const onAnswer = vi.fn();
    const earlier: UIMessage = {
      id: 'm0',
      role: 'assistant',
      parts: [
        {
          type: 'tool-ask',
          toolCallId: 'ask-earlier',
          state: 'input-available',
          input: { questions: QUESTIONS },
        } as UIMessage['parts'][number],
      ],
    };
    const { result } = renderHook(() =>
      useChatTranscript({ messages: [earlier, ...parked()], status: 'ready', onAnswer }),
    );
    const setAt = (index: number) =>
      result.current.items[index]?.blocks[0] as TranscriptElicitationBlock;

    act(() => setAt(0).questions[0]?.options[0]?.select());
    act(() => setAt(2).questions[1]?.options[1]?.select());
    act(() => setAt(2).answer.run());

    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer).toHaveBeenCalledWith('intake-run-1', { tests: ['unit', 'e2e'] });
  });

  it('submits nothing at all when the user just confirmed', async () => {
    const onAnswer = vi.fn();
    const { result } = transcript({ onAnswer });

    act(() => questionSet(result).answer.run());

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('intake-run-1', {}));
  });

  it('reports the submission in flight', async () => {
    let release: () => void = () => undefined;
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = transcript({ onAnswer });

    act(() => questionSet(result).answer.run());
    await waitFor(() => expect(questionSet(result).answer.isSubmitting).toBe(true));
    await act(async () => {
      release();
    });
    // The run is still parked until its own frame settles the part, so the form stays busy.
    expect(questionSet(result).answer.isSubmitting).toBe(true);
  });

  it('surfaces a refused submission instead of dropping it on the floor', async () => {
    const onAnswer = vi.fn(() => Promise.reject(new Error('Agent request failed: 403 Forbidden')));
    const { result } = transcript({ onAnswer });

    act(() => questionSet(result).answer.run());

    await waitFor(() =>
      expect(questionSet(result).error).toBe('Agent request failed: 403 Forbidden'),
    );
    expect(questionSet(result).answer.isSubmitting).toBe(false);
    expect(questionSet(result).answer.available).toBe(true);
  });

  it('clears a previous failure when the user tries again', async () => {
    const onAnswer = vi
      .fn<[string, Record<string, string[]>], Promise<void>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(undefined);
    const { result } = transcript({ onAnswer });

    act(() => questionSet(result).answer.run());
    await waitFor(() => expect(questionSet(result).error).toBe('nope'));
    act(() => questionSet(result).answer.run());
    await waitFor(() => expect(questionSet(result).error).toBeNull());
  });

  it('routes a skip to its own handler — declining is not answering', async () => {
    const onAnswer = vi.fn();
    const onSkip = vi.fn();
    const { result } = transcript({ onAnswer, onSkip });

    act(() => questionSet(result).skip.run());

    await waitFor(() => expect(onSkip).toHaveBeenCalledWith('intake-run-1'));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe('useChatTranscript — approving a parked tool call', () => {
  function pendingApproval(): UIMessage[] {
    return [
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'tool-purgeCache',
            toolCallId: 'call-2',
            state: 'input-available',
            input: { key: 'all' },
            toolMetadata: { toolKind: 'action' },
          } as UIMessage['parts'][number],
        ],
      },
    ];
  }

  function call(result: { current: ReturnType<typeof useChatTranscript> }) {
    const block = result.current.items.at(-1)?.blocks[0] as TranscriptToolBlock;
    return block.calls[0];
  }

  it('offers approve and reject on an action tool waiting for a person', async () => {
    const onApprove = vi.fn();
    const { result } = renderHook(() =>
      useChatTranscript({ messages: pendingApproval(), status: 'streaming', onApprove }),
    );

    expect(call(result)?.isAwaitingApproval).toBe(true);
    expect(call(result)?.approve.available).toBe(true);
    expect(call(result)?.reject.available).toBe(false);
    act(() => call(result)?.approve.run());
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith('call-2'));
  });

  it('surfaces a refused decision on the call it belongs to', async () => {
    const onReject = vi.fn(() => Promise.reject(new Error('not your thread')));
    const { result } = renderHook(() =>
      useChatTranscript({ messages: pendingApproval(), status: 'streaming', onReject }),
    );

    act(() => call(result)?.reject.run());
    await waitFor(() => expect(call(result)?.error).toBe('not your thread'));
  });
});
