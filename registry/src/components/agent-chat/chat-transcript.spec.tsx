// @vitest-environment jsdom
import { type ChatStatus, useChatTranscript } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ChatTranscriptView } from './chat-transcript';

function say(id: string, role: UIMessage['role'], text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function Harness({
  messages,
  status = 'ready',
  followUps,
  onFollowUpSelect,
}: {
  messages: UIMessage[];
  status?: ChatStatus;
  followUps?: string[];
  onFollowUpSelect?: (text: string) => void;
}) {
  const transcript = useChatTranscript({ messages, status, followUps });
  return (
    <ChatTranscriptView
      transcript={transcript}
      followUps={followUps}
      onFollowUpSelect={onFollowUpSelect}
    />
  );
}

/** jsdom lays nothing out, so the scroll metrics the model reads have to be supplied. */
function makeScrollable(element: Element, { scrollTop }: { scrollTop: number }) {
  Object.defineProperty(element, 'scrollHeight', { value: 2000, writable: true });
  Object.defineProperty(element, 'clientHeight', { value: 400, writable: true });
  element.scrollTop = scrollTop;
}

function scroller(): HTMLElement {
  const element = document.querySelector('[data-slot="chat-transcript-scroller"]');
  if (!element) {
    throw new Error('the transcript rendered no scroll container');
  }
  return element as HTMLElement;
}

const conversation = [say('u1', 'user', 'hello'), say('a1', 'assistant', 'hi')];

describe('ChatTranscriptView scrolling', () => {
  it('offers no jump-to-latest while the reader is at the bottom', () => {
    render(<Harness messages={conversation} />);
    expect(screen.queryByLabelText('Jump to latest')).toBeNull();
  });

  it('offers a jump-to-latest once the reader scrolls away', () => {
    render(<Harness messages={conversation} />);
    const element = scroller();

    makeScrollable(element, { scrollTop: 100 });
    fireEvent.scroll(element);

    expect(screen.getByLabelText('Jump to latest')).toBeTruthy();
  });

  it('re-pins to the bottom and withdraws the affordance', () => {
    render(<Harness messages={conversation} />);
    const element = scroller();
    makeScrollable(element, { scrollTop: 100 });
    fireEvent.scroll(element);

    fireEvent.click(screen.getByLabelText('Jump to latest'));

    expect(element.scrollTop).toBe(2000);
    expect(screen.queryByLabelText('Jump to latest')).toBeNull();
  });
});

describe('ChatTranscriptView list state', () => {
  it('mounts a window and offers the rest', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      say(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', `line ${index}`),
    );
    render(<Harness messages={many} />);

    expect(screen.getByText('Load 10 earlier')).toBeTruthy();
    expect(screen.queryByText('line 5')).toBeNull();

    fireEvent.click(screen.getByText('Load 10 earlier'));

    expect(screen.getByText('line 5')).toBeTruthy();
    expect(screen.queryByText('Load 10 earlier')).toBeNull();
  });

  it('waits for the first token with a typing line', () => {
    render(<Harness messages={[say('u1', 'user', 'hello')]} status="submitted" />);
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('shows follow-ups only once the answer has landed', () => {
    const onFollowUpSelect = vi.fn();
    const { unmount } = render(
      <Harness
        messages={conversation}
        status="streaming"
        followUps={['Draft the pattern note']}
        onFollowUpSelect={onFollowUpSelect}
      />,
    );
    expect(screen.queryByText('Draft the pattern note')).toBeNull();
    unmount();

    render(
      <Harness
        messages={conversation}
        followUps={['Draft the pattern note']}
        onFollowUpSelect={onFollowUpSelect}
      />,
    );
    fireEvent.click(screen.getByText('Draft the pattern note'));
    expect(onFollowUpSelect).toHaveBeenCalledWith('Draft the pattern note');
  });
});
