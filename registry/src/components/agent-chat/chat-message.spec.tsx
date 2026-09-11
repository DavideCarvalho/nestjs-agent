// @vitest-environment jsdom
import { type ChatStatus, useChatTranscript } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessage } from './chat-message';

function say(id: string, role: UIMessage['role'], text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

const conversation = [
  say('u1', 'user', 'catch me up on the 3.4 release'),
  say('a1', 'assistant', 'two blockers cleared'),
];

interface HarnessProps {
  messages?: UIMessage[];
  status?: ChatStatus;
  editable?: boolean;
  onEditSubmit?: (messageId: string, text: string) => void;
  onFork?: (messageId: string) => void;
  regeneratable?: boolean;
  onRegenerate?: (messageId: string) => void;
  writeClipboard?: (text: string) => Promise<void>;
}

function Harness({ messages = conversation, status = 'ready', ...options }: HarnessProps) {
  const transcript = useChatTranscript({ messages, status, ...options });
  return (
    <>
      {transcript.items.map((item) => (
        <ChatMessage key={item.id} item={item} />
      ))}
    </>
  );
}

describe('ChatMessage actions', () => {
  it('copies the message prose and flashes that it did', async () => {
    const writeClipboard = vi.fn(async () => undefined);
    render(<Harness writeClipboard={writeClipboard} />);

    fireEvent.click(screen.getAllByLabelText('Copy message')[0] as HTMLElement);

    await waitFor(() => expect(screen.getByLabelText('Copied')).toBeTruthy());
    expect(writeClipboard).toHaveBeenCalledWith('catch me up on the 3.4 release');
  });

  it('offers no edit affordance unless the host wired one', () => {
    render(<Harness />);
    expect(screen.queryByLabelText('Edit and resend')).toBeNull();
  });

  it('edits a user message and resends it', () => {
    const onEditSubmit = vi.fn();
    render(<Harness editable onEditSubmit={onEditSubmit} />);

    fireEvent.click(screen.getByLabelText('Edit and resend'));
    const textarea = screen.getByLabelText('Edit message') as HTMLTextAreaElement;
    expect(textarea.value).toBe('catch me up on the 3.4 release');

    fireEvent.change(textarea, { target: { value: 'catch me up on 3.5' } });
    fireEvent.click(screen.getByText('Resend'));

    expect(onEditSubmit).toHaveBeenCalledWith('u1', 'catch me up on 3.5');
  });

  it('refuses to resend an empty edit', () => {
    const onEditSubmit = vi.fn();
    render(<Harness editable onEditSubmit={onEditSubmit} />);
    fireEvent.click(screen.getByLabelText('Edit and resend'));
    fireEvent.change(screen.getByLabelText('Edit message'), { target: { value: '   ' } });

    expect((screen.getByText('Resend') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Resend'));
    expect(onEditSubmit).not.toHaveBeenCalled();
  });

  it('abandons an edit on cancel', () => {
    render(<Harness editable onEditSubmit={() => undefined} />);
    fireEvent.click(screen.getByLabelText('Edit and resend'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Edit message')).toBeNull();
  });

  it('offers regenerate on the last assistant message only', () => {
    const onRegenerate = vi.fn();
    render(
      <Harness
        messages={[
          ...conversation,
          say('u2', 'user', 'and after that?'),
          say('a2', 'assistant', 'the billing export is still waiting'),
        ]}
        regeneratable
        onRegenerate={onRegenerate}
      />,
    );

    const buttons = screen.getAllByLabelText('Regenerate');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onRegenerate).toHaveBeenCalledWith('a2');
  });

  it('forks from whichever message the reader points at', () => {
    const onFork = vi.fn();
    render(<Harness onFork={onFork} />);

    fireEvent.click(screen.getAllByLabelText('Fork from here')[1] as HTMLElement);

    expect(onFork).toHaveBeenCalledWith('a1');
  });

  it('separates the two roles in the markup', () => {
    render(<Harness />);
    const roles = screen.getAllByRole('article').map((node) => node.getAttribute('data-role'));
    expect(roles).toEqual(['user', 'assistant']);
  });
});
