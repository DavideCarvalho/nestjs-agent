// @vitest-environment jsdom
import { type TranscriptReasoningBlock, useTranscriptItem } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ChatReasoning } from './chat-reasoning';

function message(state: 'streaming' | 'done'): UIMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'four elements did the work', state },
      { type: 'text', text: 'here is the answer' },
    ],
  };
}

/** The disclosure state under test belongs to the model, so the model is what drives it. */
function Harness({
  state,
  duration,
}: {
  state: 'streaming' | 'done';
  duration?: ReactNode;
}) {
  const item = useTranscriptItem({ message: message(state), isStreaming: state === 'streaming' });
  const block = item.blocks.find(
    (candidate): candidate is TranscriptReasoningBlock => candidate.kind === 'reasoning',
  );
  return block ? <ChatReasoning block={block} label="Trust Elements" duration={duration} /> : null;
}

describe('ChatReasoning', () => {
  it('folds a finished run away behind its label', () => {
    render(<Harness state="done" />);
    expect(screen.getByText('Trust Elements')).toBeTruthy();
    expect(screen.queryByText('four elements did the work')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals the thinking when the disclosure is toggled', () => {
    render(<Harness state="done" />);

    fireEvent.click(screen.getByText('Trust Elements'));

    expect(screen.getByText('four elements did the work')).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('folds it back on a second toggle', () => {
    render(<Harness state="done" />);
    fireEvent.click(screen.getByText('Trust Elements'));
    fireEvent.click(screen.getByText('Trust Elements'));
    expect(screen.queryByText('four elements did the work')).toBeNull();
  });

  it('leaves a run that is still streaming open', () => {
    render(<Harness state="streaming" />);
    expect(screen.getByText('four elements did the work')).toBeTruthy();
  });

  it('shows a duration only when the host has one', () => {
    const { unmount } = render(<Harness state="done" />);
    expect(screen.queryByText('9s')).toBeNull();
    unmount();

    render(<Harness state="done" duration="9s" />);
    expect(screen.getByText('9s')).toBeTruthy();
  });
});
