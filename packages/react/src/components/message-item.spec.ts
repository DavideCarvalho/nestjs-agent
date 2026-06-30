// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MessageItem } from './message-item.js';

function textMessage(role: UIMessage['role'], text: string, id = 'm1'): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

describe('MessageItem affordances', () => {
  it('fires onFork with the message id', () => {
    const onFork = vi.fn();
    render(createElement(MessageItem, { message: textMessage('assistant', 'hi'), onFork }));
    fireEvent.click(screen.getByTitle('Fork thread from this message'));
    expect(onFork).toHaveBeenCalledWith('m1');
  });

  it('shows Regenerate only for assistant messages and fires onRegenerate', () => {
    const onRegenerate = vi.fn();
    render(
      createElement(MessageItem, {
        message: textMessage('assistant', 'answer'),
        regeneratable: true,
        onRegenerate,
      }),
    );
    fireEvent.click(screen.getByTitle('Regenerate response'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('edits a user message and submits the new text on Enter', () => {
    const onEditSubmit = vi.fn();
    render(
      createElement(MessageItem, {
        message: textMessage('user', 'old text'),
        editable: true,
        onEditSubmit,
      }),
    );
    fireEvent.click(screen.getByTitle('Edit & resubmit'));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'new text' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onEditSubmit).toHaveBeenCalledWith('new text');
  });

  it('renders the usage line for an assistant turn', () => {
    render(
      createElement(MessageItem, {
        message: textMessage('assistant', 'answer'),
        usage: { inputTokens: 1200, outputTokens: 800, costUsd: 0.0123 },
      }),
    );
    // 2k tokens total, cost formatted under $1 to 3 decimals.
    expect(screen.getByText(/2\.0k tokens/)).toBeTruthy();
    expect(screen.getByText(/\$0\.012/)).toBeTruthy();
  });
});
