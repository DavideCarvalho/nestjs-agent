// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInput } from './chat-input.js';

describe('ChatInput stop', () => {
  it('offers no stop affordance while idle', () => {
    render(createElement(ChatInput, { onSubmit: () => undefined, onStop: () => undefined }));
    expect(screen.queryByText('Stop generating')).toBeNull();
  });

  it('cancels the turn in flight', () => {
    const onStop = vi.fn();
    render(createElement(ChatInput, { onSubmit: () => undefined, onStop, isStreaming: true }));
    fireEvent.click(screen.getByText('Stop generating'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the host wired no canceller', () => {
    render(createElement(ChatInput, { onSubmit: () => undefined, isStreaming: true }));
    expect(screen.queryByText('Stop generating')).toBeNull();
  });

  it('takes the host label for the stop button', () => {
    render(
      createElement(ChatInput, {
        onSubmit: () => undefined,
        onStop: () => undefined,
        isStreaming: true,
        stopLabel: 'Halt',
      }),
    );
    expect(screen.getByText('Halt')).toBeTruthy();
    expect(screen.getByLabelText('Stop generating')).toBeTruthy();
  });
});
