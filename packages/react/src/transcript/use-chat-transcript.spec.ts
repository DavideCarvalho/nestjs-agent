// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type UseChatTranscriptOptions,
  useChatTranscript,
  useTranscriptItem,
} from './use-chat-transcript.js';

function text(role: UIMessage['role'], body: string, id: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text: body }] };
}

function thread(count: number): UIMessage[] {
  return Array.from({ length: count }, (_, index) =>
    text(index % 2 === 0 ? 'user' : 'assistant', `message ${index}`, `m${index}`),
  );
}

function transcript(options: UseChatTranscriptOptions) {
  return renderHook((props: UseChatTranscriptOptions) => useChatTranscript(props), {
    initialProps: options,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useChatTranscript — the window', () => {
  it('mounts only the tail of a long thread', () => {
    const { result } = transcript({ messages: thread(120), status: 'ready' });
    expect(result.current.items).toHaveLength(50);
    expect(result.current.items[0]?.id).toBe('m70');
    expect(result.current.window.hiddenCount).toBe(70);
    expect(result.current.window.canLoadEarlier).toBe(true);
  });

  it('reveals another chunk on demand', () => {
    const { result } = transcript({ messages: thread(120), status: 'ready' });
    act(() => result.current.window.loadEarlier());
    expect(result.current.items).toHaveLength(100);
    expect(result.current.window.hiddenCount).toBe(20);
  });

  it('reveals everything at once when asked', () => {
    const { result } = transcript({ messages: thread(120), status: 'ready' });
    act(() => result.current.window.showAll());
    expect(result.current.items).toHaveLength(120);
    expect(result.current.window.canLoadEarlier).toBe(false);
  });

  it('keeps a short thread whole', () => {
    const { result } = transcript({ messages: thread(3), status: 'ready' });
    expect(result.current.items).toHaveLength(3);
    expect(result.current.window.hiddenCount).toBe(0);
    expect(result.current.window.canLoadEarlier).toBe(false);
  });

  it('numbers items by their position in the FULL thread, not the window', () => {
    const { result } = transcript({ messages: thread(120), status: 'ready' });
    expect(result.current.items[0]?.index).toBe(70);
  });
});

describe('useChatTranscript — turn state', () => {
  it('asks for the empty state only when idle and empty', () => {
    const { result, rerender } = transcript({ messages: [], status: 'ready' });
    expect(result.current.showEmptyState).toBe(true);
    rerender({ messages: [], status: 'submitted' });
    expect(result.current.showEmptyState).toBe(false);
  });

  it('asks for a typing indicator until the assistant message exists', () => {
    const messages = [text('user', 'hi', 'u1')];
    const { result, rerender } = transcript({ messages, status: 'submitted' });
    expect(result.current.showTypingIndicator).toBe(true);
    rerender({ messages: [...messages, text('assistant', '', 'a1')], status: 'streaming' });
    expect(result.current.showTypingIndicator).toBe(false);
  });

  it('offers follow-ups only after a settled assistant turn', () => {
    const messages = [text('user', 'hi', 'u1'), text('assistant', 'hello', 'a1')];
    const { result, rerender } = transcript({
      messages,
      status: 'streaming',
      followUps: ['and then?'],
    });
    expect(result.current.showFollowUps).toBe(false);
    rerender({ messages, status: 'ready', followUps: ['and then?'] });
    expect(result.current.showFollowUps).toBe(true);
    rerender({ messages, status: 'ready', followUps: [] });
    expect(result.current.showFollowUps).toBe(false);
  });

  it('marks only the last assistant message as streaming', () => {
    const messages = [
      text('assistant', 'older', 'a1'),
      text('user', 'more', 'u1'),
      text('assistant', 'newer', 'a2'),
    ];
    const { result } = transcript({ messages, status: 'streaming' });
    expect(result.current.items.map((item) => item.isStreaming)).toEqual([false, false, true]);
    expect(result.current.lastAssistantId).toBe('a2');
  });

  it('marks the last assistant message even when a newer user message follows it', () => {
    const messages = [text('assistant', 'answer', 'a1'), text('user', 'follow-up', 'u1')];
    const { result } = transcript({ messages, status: 'streaming' });
    expect(result.current.items.map((item) => item.isStreaming)).toEqual([true, false]);
  });

  it('stops marking anything as streaming once the turn settles', () => {
    const messages = [text('assistant', 'answer', 'a1')];
    const { result, rerender } = transcript({ messages, status: 'streaming' });
    expect(result.current.items[0]?.isStreaming).toBe(true);
    rerender({ messages, status: 'ready' });
    expect(result.current.items[0]?.isStreaming).toBe(false);
  });
});

describe('useChatTranscript — stop', () => {
  it('offers stop only while a turn is in flight', () => {
    const onStop = vi.fn();
    const messages = [text('user', 'hi', 'u1')];
    const { result, rerender } = transcript({ messages, status: 'ready', onStop });
    expect(result.current.stop.available).toBe(false);
    rerender({ messages, status: 'submitted', onStop });
    expect(result.current.stop.available).toBe(true);
    rerender({ messages, status: 'streaming', onStop });
    expect(result.current.stop.available).toBe(true);
  });

  it('has nothing to offer when the host wired no canceller', () => {
    const { result } = transcript({ messages: [], status: 'streaming' });
    expect(result.current.stop.available).toBe(false);
  });

  it('cancels the turn and reports the request until the turn settles', () => {
    const onStop = vi.fn();
    const messages = [text('user', 'hi', 'u1')];
    const { result, rerender } = transcript({ messages, status: 'streaming', onStop });

    act(() => result.current.stop.stop());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(result.current.stop.isStopping).toBe(true);

    rerender({ messages, status: 'ready', onStop });
    expect(result.current.stop.isStopping).toBe(false);
  });

  it('ignores a stop for a turn that is not running', () => {
    const onStop = vi.fn();
    const { result } = transcript({ messages: [], status: 'ready', onStop });
    act(() => result.current.stop.stop());
    expect(onStop).not.toHaveBeenCalled();
    expect(result.current.stop.isStopping).toBe(false);
  });
});

describe('useChatTranscript — copy', () => {
  it('writes the message prose and reports it, then resets', async () => {
    vi.useFakeTimers();
    const writeClipboard = vi.fn(async () => undefined);
    const { result } = transcript({
      messages: [text('assistant', 'the answer', 'a1')],
      status: 'ready',
      writeClipboard,
    });

    await act(async () => {
      result.current.items[0]?.copy.copy();
    });
    expect(writeClipboard).toHaveBeenCalledWith('the answer');
    expect(result.current.items[0]?.copy.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.items[0]?.copy.copied).toBe(false);
  });

  it('leaves the reported state alone when the clipboard refuses', async () => {
    const writeClipboard = vi.fn(async () => {
      throw new Error('denied');
    });
    const { result } = transcript({
      messages: [text('assistant', 'the answer', 'a1')],
      status: 'ready',
      writeClipboard,
    });

    await act(async () => {
      result.current.items[0]?.copy.copy();
    });
    expect(result.current.items[0]?.copy.copied).toBe(false);
  });

  it('reports nothing to copy for a message with no prose', () => {
    const { result } = transcript({
      messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }] }],
      status: 'ready',
    });
    expect(result.current.items[0]?.copy.available).toBe(false);
  });

  it('copies each message independently', async () => {
    const writeClipboard = vi.fn(async () => undefined);
    const { result } = transcript({
      messages: [text('assistant', 'first', 'a1'), text('assistant', 'second', 'a2')],
      status: 'ready',
      writeClipboard,
    });

    await act(async () => {
      result.current.items[1]?.copy.copy();
    });
    expect(writeClipboard).toHaveBeenCalledWith('second');
    expect(result.current.items.map((item) => item.copy.copied)).toEqual([false, true]);
  });
});

describe('useChatTranscript — edit', () => {
  const editable = (onEditSubmit: (messageId: string, text: string) => void) => ({
    messages: [text('user', 'old text', 'u1')],
    status: 'ready' as const,
    editable: true,
    onEditSubmit,
  });

  it('offers editing only on user messages, and only when wired', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript({
      messages: [text('user', 'hi', 'u1'), text('assistant', 'hello', 'a1')],
      status: 'ready',
      editable: true,
      onEditSubmit,
    });
    expect(result.current.items.map((item) => item.edit.available)).toEqual([true, false]);

    const { result: unwired } = transcript({
      messages: [text('user', 'hi', 'u1')],
      status: 'ready',
      editable: true,
    });
    expect(unwired.current.items[0]?.edit.available).toBe(false);
  });

  it('starts the draft from the message text and submits the edit', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));

    act(() => result.current.items[0]?.edit.start());
    expect(result.current.items[0]?.edit.isEditing).toBe(true);
    expect(result.current.items[0]?.edit.draft).toBe('old text');

    act(() => result.current.items[0]?.edit.setDraft('new text'));
    act(() => result.current.items[0]?.edit.save());

    expect(onEditSubmit).toHaveBeenCalledWith('u1', 'new text');
    expect(result.current.items[0]?.edit.isEditing).toBe(false);
  });

  it('refuses a blank draft', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());
    act(() => result.current.items[0]?.edit.setDraft('   '));

    expect(result.current.items[0]?.edit.canSave).toBe(false);
    act(() => result.current.items[0]?.edit.save());
    expect(onEditSubmit).not.toHaveBeenCalled();
    expect(result.current.items[0]?.edit.isEditing).toBe(true);
  });

  it('trims the submitted text', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());
    act(() => result.current.items[0]?.edit.setDraft('  padded  '));
    act(() => result.current.items[0]?.edit.save());
    expect(onEditSubmit).toHaveBeenCalledWith('u1', 'padded');
  });

  it('discards the draft on cancel', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());
    act(() => result.current.items[0]?.edit.setDraft('half-written'));
    act(() => result.current.items[0]?.edit.cancel());

    expect(result.current.items[0]?.edit.isEditing).toBe(false);
    expect(onEditSubmit).not.toHaveBeenCalled();
    act(() => result.current.items[0]?.edit.start());
    expect(result.current.items[0]?.edit.draft).toBe('old text');
  });

  it('saves on Enter and cancels on Escape through the textarea props', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());

    const props = result.current.items[0]?.edit.getTextareaProps();
    const enter = { key: 'Enter', shiftKey: false, preventDefault: vi.fn() };
    act(() => props?.onKeyDown(enter as never));
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(onEditSubmit).toHaveBeenCalledWith('u1', 'old text');

    act(() => result.current.items[0]?.edit.start());
    const escapeKey = { key: 'Escape', shiftKey: false, preventDefault: vi.fn() };
    act(() => props?.onKeyDown(escapeKey as never));
    expect(result.current.items[0]?.edit.isEditing).toBe(false);
  });

  it('leaves Shift+Enter to the textarea so a draft can hold newlines', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());
    const props = result.current.items[0]?.edit.getTextareaProps();
    const shiftEnter = { key: 'Enter', shiftKey: true, preventDefault: vi.fn() };
    act(() => props?.onKeyDown(shiftEnter as never));
    expect(shiftEnter.preventDefault).not.toHaveBeenCalled();
    expect(onEditSubmit).not.toHaveBeenCalled();
  });

  it('keeps the textarea ref identity stable across keystrokes', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());
    const first = result.current.items[0]?.edit.getTextareaProps().ref;
    act(() => result.current.items[0]?.edit.setDraft('typing…'));
    expect(result.current.items[0]?.edit.getTextareaProps().ref).toBe(first);
  });

  it('focuses the textarea with the caret after the existing text', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript(editable(onEditSubmit));
    act(() => result.current.items[0]?.edit.start());
    const element = document.createElement('textarea');
    element.value = 'old text';
    document.body.append(element);

    act(() => result.current.items[0]?.edit.getTextareaProps().ref(element));

    expect(document.activeElement).toBe(element);
    expect(element.selectionStart).toBe('old text'.length);
    element.remove();
  });

  it('edits one message without opening another', () => {
    const onEditSubmit = vi.fn();
    const { result } = transcript({
      messages: [text('user', 'first', 'u1'), text('user', 'second', 'u2')],
      status: 'ready',
      editable: true,
      onEditSubmit,
    });
    act(() => result.current.items[1]?.edit.start());
    expect(result.current.items.map((item) => item.edit.isEditing)).toEqual([false, true]);
    act(() => result.current.items[1]?.edit.save());
    expect(onEditSubmit).toHaveBeenCalledWith('u2', 'second');
  });
});

describe('useChatTranscript — fork and regenerate', () => {
  it('forks by message id when the host wired it', () => {
    const onFork = vi.fn();
    const { result } = transcript({
      messages: [text('assistant', 'answer', 'a1')],
      status: 'ready',
      onFork,
    });
    expect(result.current.items[0]?.fork.available).toBe(true);
    act(() => result.current.items[0]?.fork.run());
    expect(onFork).toHaveBeenCalledWith('a1');
  });

  it('offers no fork without a handler', () => {
    const { result } = transcript({ messages: [text('assistant', 'a', 'a1')], status: 'ready' });
    expect(result.current.items[0]?.fork.available).toBe(false);
  });

  it('offers regenerate on the last assistant message only', () => {
    const onRegenerate = vi.fn();
    const { result } = transcript({
      messages: [
        text('assistant', 'older', 'a1'),
        text('user', 'again', 'u1'),
        text('assistant', 'newer', 'a2'),
      ],
      status: 'ready',
      regeneratable: true,
      onRegenerate,
    });
    expect(result.current.items.map((item) => item.isLastAssistant)).toEqual([false, false, true]);
    expect(result.current.items.map((item) => item.regenerate.available)).toEqual([
      false,
      false,
      true,
    ]);
    act(() => result.current.items[2]?.regenerate.run());
    expect(onRegenerate).toHaveBeenCalledWith('a2');
  });

  it('withholds regenerate unless the host opted in', () => {
    const onRegenerate = vi.fn();
    const { result } = transcript({
      messages: [text('assistant', 'answer', 'a1')],
      status: 'ready',
      onRegenerate,
    });
    expect(result.current.items[0]?.regenerate.available).toBe(false);
  });
});

describe('useChatTranscript — derived per-message values', () => {
  it('summarizes the usage a host resolves for a turn', () => {
    const { result } = transcript({
      messages: [text('assistant', 'answer', 'a1')],
      status: 'ready',
      getUsage: () => ({ inputTokens: 1200, outputTokens: 800, costUsd: 0.0123 }),
    });
    expect(result.current.items[0]?.usage).toMatchObject({
      totalTokens: 2000,
      tokensLabel: '2.0k tokens',
      costLabel: '$0.012',
    });
  });

  it('describes the persisted timestamp and drops an unparseable one', () => {
    const messages = [text('assistant', 'answer', 'a1')];
    const { result, rerender } = transcript({
      messages,
      status: 'ready',
      getCreatedAt: () => new Date().toISOString(),
    });
    expect(result.current.items[0]?.timestamp?.relative).toBe('just now');
    rerender({ messages, status: 'ready', getCreatedAt: () => 'yesterday-ish' });
    expect(result.current.items[0]?.timestamp).toBeNull();
  });

  it('groups the parts of a turn into blocks', () => {
    const { result } = transcript({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'consider X', state: 'done' },
            {
              type: 'tool-search',
              toolCallId: 't1',
              state: 'output-available',
              input: {},
              output: {},
            },
            {
              type: 'tool-search',
              toolCallId: 't2',
              state: 'output-available',
              input: {},
              output: {},
            },
            { type: 'text', text: 'the answer' },
          ],
        } as UIMessage,
      ],
      status: 'ready',
    });
    expect(result.current.items[0]?.blocks.map((block) => block.kind)).toEqual([
      'reasoning',
      'tools',
      'text',
    ]);
  });

  it('toggles one reasoning run without disturbing another', () => {
    const { result } = transcript({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'first thought', state: 'done' },
            { type: 'text', text: 'partial' },
            { type: 'reasoning', text: 'second thought', state: 'done' },
          ],
        } as UIMessage,
      ],
      status: 'ready',
    });
    const openStates = () =>
      result.current.items[0]?.blocks
        .filter((block) => block.kind === 'reasoning')
        .map((block) => block.isOpen);

    expect(openStates()).toEqual([false, false]);
    const first = result.current.items[0]?.blocks[0];
    act(() => {
      if (first?.kind === 'reasoning') first.toggle();
    });
    expect(openStates()).toEqual([true, false]);
  });
});

describe('useTranscriptItem', () => {
  it('models one message on its own', () => {
    const onFork = vi.fn();
    const { result } = renderHook(() =>
      useTranscriptItem({ message: text('assistant', 'answer', 'a1'), onFork }),
    );
    expect(result.current.id).toBe('a1');
    expect(result.current.text).toBe('answer');
    expect(result.current.fork.available).toBe(true);
  });

  it('takes its streaming flag from the caller, whatever the role', () => {
    const { result } = renderHook(() =>
      useTranscriptItem({ message: text('user', 'hi', 'u1'), isStreaming: true }),
    );
    expect(result.current.isStreaming).toBe(true);
  });

  it('treats a lone assistant message as the last one for regenerate', () => {
    const onRegenerate = vi.fn();
    const { result } = renderHook(() =>
      useTranscriptItem({
        message: text('assistant', 'answer', 'a1'),
        regeneratable: true,
        onRegenerate,
      }),
    );
    expect(result.current.regenerate.available).toBe(true);
  });
});
