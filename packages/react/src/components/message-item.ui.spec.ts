// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageItem } from './message-item.js';

afterEach(cleanup);

const message: UIMessage = {
  id: 'm1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Before' },
    { type: 'data-ui', id: 'ui-1', data: { id: 'ui-1', component: 'stat', props: { value: 7 } } },
  ],
};

describe('MessageItem — pushed UI', () => {
  it('hands a pushed component to renderUi, in position', () => {
    const { container } = render(
      createElement(MessageItem, {
        message,
        renderUi: (block) => `${block.component}=${String(block.props.value)}`,
      }),
    );
    expect(screen.getByText('stat=7')).toBeTruthy();
    const slot = container.querySelector('[data-slot="ui"]');
    expect(slot?.getAttribute('data-component')).toBe('stat');
  });

  it('draws nothing for a pushed component when no renderUi is given', () => {
    const { container } = render(createElement(MessageItem, { message }));
    expect(container.querySelector('[data-slot="ui"]')).toBeNull();
  });
});
