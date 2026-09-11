// @vitest-environment jsdom
import { type ChatStatus, useChatTranscript } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './chat-composer';

/** The composer is driven by the real stop machine, not a hand-made object. */
function Harness({
  status,
  onStop,
  onSubmit = () => undefined,
}: {
  status: ChatStatus;
  onStop?: () => void;
  onSubmit?: (text: string) => void;
}) {
  const transcript = useChatTranscript({ messages: [], status, onStop });
  return <ChatComposer onSubmit={onSubmit} stop={transcript.stop} />;
}

describe('ChatComposer', () => {
  it('offers submit while the chat is idle', () => {
    render(<Harness status="ready" onStop={() => undefined} />);
    expect(screen.getByLabelText('Send')).toBeTruthy();
    expect(screen.queryByLabelText('Stop generating')).toBeNull();
  });

  it('replaces submit with stop while a turn is in flight', () => {
    render(<Harness status="streaming" onStop={() => undefined} />);
    expect(screen.getByLabelText('Stop generating')).toBeTruthy();
    expect(screen.queryByLabelText('Send')).toBeNull();
  });

  it('cancels the turn and then reports it is stopping', () => {
    const onStop = vi.fn();
    render(<Harness status="streaming" onStop={onStop} />);

    fireEvent.click(screen.getByLabelText('Stop generating'));

    expect(onStop).toHaveBeenCalledTimes(1);
    const stopping = screen.getByLabelText('Stopping');
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps submit when a busy chat has nothing to cancel with', () => {
    render(<Harness status="streaming" />);
    expect(screen.getByLabelText('Send')).toBeTruthy();
    expect(screen.queryByLabelText('Stop generating')).toBeNull();
  });

  it('submits the trimmed draft and clears the box', () => {
    const onSubmit = vi.fn();
    render(<Harness status="ready" onSubmit={onSubmit} />);
    const textarea = screen.getByLabelText('Ask anything') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '  catch me up  ' } });
    fireEvent.click(screen.getByLabelText('Send'));

    expect(onSubmit).toHaveBeenCalledWith('catch me up');
    expect(textarea.value).toBe('');
  });

  it('refuses to submit an empty draft', () => {
    const onSubmit = vi.fn();
    render(<Harness status="ready" onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends on Enter and breaks the line on Shift+Enter', () => {
    const onSubmit = vi.fn();
    render(<Harness status="ready" onSubmit={onSubmit} />);
    const textarea = screen.getByLabelText('Ask anything');

    fireEvent.change(textarea, { target: { value: 'ship it' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('ship it');
  });

  it('names the key that sends', () => {
    render(<ChatComposer onSubmit={() => undefined} submitHint="Enter" />);
    expect(screen.getByText('Enter').tagName).toBe('KBD');
  });
});
