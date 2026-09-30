// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatQueue } from '../queue/model.js';
import { ChatInput } from './chat-input.js';
import { MessageList } from './message-list.js';

describe('chat components (render smoke)', () => {
  it('ChatInput renders a send button and a textarea', () => {
    render(createElement(ChatInput, { onSubmit: () => undefined }));
    expect(screen.getByText('Send')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('MessageList renders assistant message text', () => {
    const messages: UIMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi there' }],
      },
    ];
    render(createElement(MessageList, { messages, status: 'ready' }));
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('MessageList draws waiting messages after the transcript, removable and resumable', () => {
    const queue: ChatQueue = {
      items: [
        {
          id: 'q-1',
          text: 'and in EUR?',
          attachments: [],
          state: 'queued',
          interrupt: false,
          createdAt: 'x',
        },
      ],
      paused: { reason: 'run_failed', at: 'x' },
      isSupported: true,
      add: vi.fn(),
      remove: vi.fn(async () => undefined),
      edit: vi.fn(),
      move: vi.fn(),
      clear: vi.fn(),
      resume: vi.fn(async () => undefined),
      error: null,
    };
    const { container } = render(
      createElement(MessageList, {
        messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Sorry' }] }],
        status: 'ready',
        queue,
      }),
    );
    expect(screen.getByText('and in EUR?')).toBeTruthy();
    expect(container.querySelector('[data-state="paused"]')).toBeTruthy();
    fireEvent.click(screen.getByText('Remove'));
    expect(queue.remove).toHaveBeenCalledWith('q-1');
    fireEvent.click(screen.getByText('Resume'));
    expect(queue.resume).toHaveBeenCalled();
  });

  it('MessageList renders the empty state when idle and empty', () => {
    render(
      createElement(MessageList, {
        messages: [],
        status: 'ready',
        emptyState: 'Start a conversation',
      }),
    );
    expect(screen.getByText('Start a conversation')).toBeTruthy();
  });
});
