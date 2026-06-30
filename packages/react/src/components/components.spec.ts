// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
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
