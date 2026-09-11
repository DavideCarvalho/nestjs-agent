// @vitest-environment jsdom
import { type TranscriptElicitationBlock, useChatTranscript } from '@dudousxd/nestjs-agent-react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ChatElicitation } from './chat-elicitation';
import { ChatMessage } from './chat-message';

const QUESTIONS = [
  {
    id: 'scope',
    prompt: 'How much should I cover?',
    options: [
      { value: 'file', label: 'This file', hotkey: 'a' },
      { value: 'module', label: 'The whole module', hotkey: 'b' },
    ],
    defaults: ['module'],
  },
  {
    id: 'tests',
    prompt: 'Which tests should I touch?',
    multiple: true,
    options: [
      { value: 'unit', label: 'Unit', hotkey: 'a' },
      { value: 'e2e', label: 'End to end', hotkey: 'b' },
    ],
    defaults: ['unit'],
  },
];

function askPart(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool-ask',
    toolCallId: 'intake-run-1',
    state: 'input-available',
    input: { preamble: 'Two questions before I start.', questions: QUESTIONS },
    ...overrides,
  } as UIMessage['parts'][number];
}

function thread(part = askPart()): UIMessage[] {
  return [{ id: 'm2', role: 'assistant', parts: [part] }];
}

interface HarnessProps {
  messages?: UIMessage[];
  onAnswer?: (toolCallId: string, answers: Record<string, string[]>) => void;
  onSkip?: (toolCallId: string) => void;
  /** Render through the whole message instead of the block alone. */
  wholeMessage?: boolean;
}

function Harness({
  messages = thread(),
  onAnswer = () => undefined,
  onSkip,
  wholeMessage = false,
}: HarnessProps) {
  const transcript = useChatTranscript({
    messages,
    status: 'streaming',
    onAnswer,
    ...(onSkip ? { onSkip } : {}),
  });
  const item = transcript.items[0];
  if (!item) {
    return null;
  }
  if (wholeMessage) {
    return <ChatMessage item={item} />;
  }
  return <ChatElicitation block={item.blocks[0] as TranscriptElicitationBlock} />;
}

function optionInput(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
}

describe('ChatElicitation', () => {
  it('reads as a numbered form with the agent picks already made', () => {
    render(<Harness />);

    expect(screen.getByText('Two questions before I start.')).toBeTruthy();
    expect(screen.getByText('Question 1 of 2')).toBeTruthy();
    expect(screen.getByText('Question 2 of 2')).toBeTruthy();
    expect(screen.getByText('How much should I cover?')).toBeTruthy();
    expect(optionInput('The whole module').checked).toBe(true);
    expect(optionInput('This file').checked).toBe(false);
    expect(optionInput('Unit').checked).toBe(true);
  });

  it('offers one choice per single question and many per multiple one', () => {
    render(<Harness />);
    expect(optionInput('This file').type).toBe('radio');
    expect(optionInput('Unit').type).toBe('checkbox');
  });

  it('moves the pick when an option is chosen', () => {
    render(<Harness />);

    fireEvent.click(optionInput('This file'));

    expect(optionInput('This file').checked).toBe(true);
    expect(optionInput('The whole module').checked).toBe(false);
  });

  it('picks by the letter the question offers, within that question only', () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByRole('group', { name: /How much should I cover/ }), { key: 'a' });

    expect(optionInput('This file').checked).toBe(true);
    // The second question offers its own 'a'; the keystroke did not reach it.
    expect(optionInput('Unit').checked).toBe(true);
    expect(optionInput('End to end').checked).toBe(false);
  });

  it('submits the questions the user touched and leaves the rest to the agent picks', () => {
    const onAnswer = vi.fn();
    render(<Harness onAnswer={onAnswer} />);

    fireEvent.click(optionInput('This file'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onAnswer).toHaveBeenCalledWith('intake-run-1', { scope: ['file'] });
  });

  it('confirms on Enter, the way the form reads', () => {
    const onAnswer = vi.fn();
    const { container } = render(<Harness onAnswer={onAnswer} />);

    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    expect(onAnswer).toHaveBeenCalledWith('intake-run-1', {});
  });

  it('offers a skip only when the host wired one', () => {
    const onSkip = vi.fn();
    const { unmount } = render(<Harness />);
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    unmount();

    render(<Harness onSkip={onSkip} />);
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    expect(onSkip).toHaveBeenCalledWith('intake-run-1');
  });

  it('goes read-only once the run settles it, and says what was chosen', () => {
    render(
      <Harness
        messages={thread(
          askPart({
            state: 'output-available',
            output: {
              answers: { scope: ['file'], tests: ['unit'] },
              skipped: false,
              defaulted: ['tests'],
              summary: 'The user answered:\nHow much should I cover? → This file',
            },
          }),
        )}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(optionInput('This file').checked).toBe(true);
    expect(optionInput('This file').disabled).toBe(true);
    expect(screen.getByText('Answered')).toBeTruthy();
  });

  it('says so when the user declined to answer', () => {
    render(
      <Harness
        messages={thread(
          askPart({
            state: 'output-available',
            output: { answers: { scope: ['module'] }, skipped: true, defaulted: ['scope'] },
          }),
        )}
      />,
    );

    expect(screen.getByText('Skipped — proceeding on the pre-picked answers')).toBeTruthy();
  });

  it('announces a refused submission and leaves the form usable', async () => {
    const onAnswer = vi.fn(() => Promise.reject(new Error('403 Forbidden')));
    render(<Harness onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '403 Forbidden');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('renders inline in the message, where the turn is', () => {
    const { container } = render(<Harness wholeMessage />);

    const article = container.querySelector('article[data-role="assistant"]');
    expect(article?.querySelector('[data-slot="chat-elicitation"]')).toBeTruthy();
  });
});
