// @vitest-environment jsdom
import { type TranscriptSourcesBlock, useTranscriptItem } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessage } from './chat-message';
import { ChatSources } from './chat-sources';

/** How inject-mode retrieval reaches the client: a settled tool call whose output is `{ passages }`. */
const answered: UIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'two blockers cleared and one is still open' },
    {
      type: 'tool-retrieve',
      toolCallId: 'retrieve-a1',
      state: 'output-available',
      input: { query: 'what shipped since Monday' },
      output: {
        passages: [
          { id: 'p1', text: 'webhook retry fix merged', score: 0.9, source: '#release' },
          { id: 'p2', text: 'migration rehearsal passed', score: 0.7, source: '#release' },
          { id: 'p3', text: 'billing export blocked', score: 0.5, source: 'ship calendar' },
        ],
      },
    },
  ] as UIMessage['parts'],
};

function SourcesHarness({ onSourceClick }: { onSourceClick?: () => void }) {
  const item = useTranscriptItem({ message: answered, sources: true });
  const block = item.blocks.find(
    (candidate): candidate is TranscriptSourcesBlock => candidate.kind === 'sources',
  );
  return block ? <ChatSources block={block} onSourceClick={onSourceClick} /> : null;
}

function MessageHarness({ sources }: { sources: boolean }) {
  const item = useTranscriptItem({ message: answered, sources });
  return <ChatMessage item={item} />;
}

describe('ChatSources', () => {
  it('counts the origins the answer was built from', () => {
    render(<SourcesHarness />);
    expect(screen.getByText('Answered from 2 sources')).toBeTruthy();
  });

  it('lists each origin with how much it contributed', () => {
    render(<SourcesHarness />);
    expect(screen.getByText('#release')).toBeTruthy();
    expect(screen.getByText('2 passages')).toBeTruthy();
    expect(screen.getByText('ship calendar')).toBeTruthy();
    expect(screen.getByText('1 passage')).toBeTruthy();
  });

  it('reports the origin the reader asked about', () => {
    const onSourceClick = vi.fn();
    render(<SourcesHarness onSourceClick={onSourceClick} />);

    fireEvent.click(screen.getByText('#release'));

    expect(onSourceClick).toHaveBeenCalledWith(expect.objectContaining({ label: '#release' }));
  });
});

describe('ChatMessage provenance', () => {
  it('puts the sources card above the answer body', () => {
    render(<MessageHarness sources />);
    const article = screen.getByRole('article');
    const nodes = [...article.querySelectorAll('[data-slot="chat-sources"], .whitespace-pre-wrap')];
    expect(nodes[0]?.getAttribute('data-slot')).toBe('chat-sources');
    expect(nodes[1]?.textContent).toBe('two blockers cleared and one is still open');
  });

  it('draws no sources card when the host did not ask the model for one', () => {
    render(<MessageHarness sources={false} />);
    expect(screen.queryByLabelText('Sources for this answer')).toBeNull();
  });
});
