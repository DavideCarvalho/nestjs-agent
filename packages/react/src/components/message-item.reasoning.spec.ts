// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MessageItem } from './message-item.js';
import { MessageList } from './message-list.js';

function reasoningMessage(state: 'streaming' | 'done'): UIMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'the user asked for X, so Y', state },
      { type: 'text', text: 'here is X' },
    ],
  };
}

describe('MessageItem reasoning', () => {
  it('folds a finished reasoning run behind a toggle', () => {
    render(createElement(MessageItem, { message: reasoningMessage('done') }));
    expect(screen.getByText('Reasoning')).toBeTruthy();
    expect(screen.queryByText('the user asked for X, so Y')).toBeNull();
    expect(screen.getByText('here is X')).toBeTruthy();
  });

  it('reveals the reasoning when the toggle is clicked', () => {
    render(createElement(MessageItem, { message: reasoningMessage('done') }));
    fireEvent.click(screen.getByText('Reasoning'));
    expect(screen.getByText('the user asked for X, so Y')).toBeTruthy();
  });

  it('shows a reasoning run that is still streaming', () => {
    render(createElement(MessageItem, { message: reasoningMessage('streaming') }));
    expect(screen.getByText('the user asked for X, so Y')).toBeTruthy();
  });

  it('hands the reasoning body to a custom renderer', () => {
    const renderReasoning = vi.fn(() => 'rendered by the host');
    render(createElement(MessageItem, { message: reasoningMessage('streaming'), renderReasoning }));
    expect(renderReasoning).toHaveBeenCalledWith('the user asked for X, so Y', {
      isStreaming: true,
      isOpen: true,
    });
    expect(screen.getByText('rendered by the host')).toBeTruthy();
  });

  it('labels the toggle however the host asks', () => {
    render(
      createElement(MessageItem, {
        message: reasoningMessage('done'),
        reasoningLabel: 'Thought process',
      }),
    );
    expect(screen.getByText('Thought process')).toBeTruthy();
  });

  it('renders reasoning through the list as well', () => {
    render(
      createElement(MessageList, {
        messages: [reasoningMessage('streaming')],
        status: 'streaming',
      }),
    );
    expect(screen.getByText('the user asked for X, so Y')).toBeTruthy();
  });
});
