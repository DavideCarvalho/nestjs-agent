// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentChat } from './agent-chat';

function assistant(parts: UIMessage['parts']): UIMessage[] {
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'purge it' }] },
    { id: 'a1', role: 'assistant', parts },
  ];
}

const ASK = {
  type: 'tool-ask',
  toolCallId: 'intake-run-1',
  state: 'input-available',
  input: {
    preamble: 'One question before I start.',
    questions: [
      {
        id: 'scope',
        prompt: 'How much should I cover?',
        options: [
          { value: 'file', label: 'This file', hotkey: 'a' },
          { value: 'module', label: 'The whole module', hotkey: 'b' },
        ],
        defaults: ['module'],
      },
    ],
  },
} as UIMessage['parts'][number];

const PENDING_ACTION = {
  type: 'tool-purgeCache',
  toolCallId: 'call-2',
  state: 'input-available',
  input: { key: 'all' },
  toolMetadata: { toolKind: 'action' },
} as UIMessage['parts'][number];

describe('AgentChat — human in the loop', () => {
  it('puts the agent question inline in the turn that asked it', () => {
    const onAnswer = vi.fn();
    const { container } = render(
      <AgentChat
        messages={assistant([ASK])}
        status="streaming"
        onSubmit={() => undefined}
        onAnswer={onAnswer}
        onSkip={() => undefined}
      />,
    );

    const form = container.querySelector('[data-slot="chat-elicitation"]');
    expect(form).toBeTruthy();
    expect(form?.closest('article[data-role="assistant"]')).toBeTruthy();
    // A single question needs no "1 of 1".
    expect(screen.queryByText(/Question 1 of/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAnswer).toHaveBeenCalledWith('intake-run-1', {});
  });

  it('offers the approval on the tool card that is waiting for it', () => {
    const onApprove = vi.fn();
    render(
      <AgentChat
        messages={assistant([PENDING_ACTION])}
        status="streaming"
        onSubmit={() => undefined}
        onApprove={onApprove}
        onReject={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onApprove).toHaveBeenCalledWith('call-2');
  });

  it('renders neither affordance for a host that wired neither', () => {
    render(
      <AgentChat
        messages={assistant([ASK, PENDING_ACTION])}
        status="streaming"
        onSubmit={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
