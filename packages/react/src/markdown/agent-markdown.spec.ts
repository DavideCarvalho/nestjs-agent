// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AgentMarkdown } from './agent-markdown.js';

describe('AgentMarkdown', () => {
  it('renders GFM markdown to formatted DOM without crashing', () => {
    const { container } = render(
      createElement(AgentMarkdown, {
        children: '# Title\n\nSome **bold** and a list:\n\n- one\n- two',
      }),
    );
    // Streamdown renders a heading element and list items; assert structure + text survive.
    expect(container.querySelector('h1')?.textContent).toContain('Title');
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('bold');
  });

  it('renders a fenced code block', () => {
    const { container } = render(
      createElement(AgentMarkdown, { children: '```ts\nconst x = 1;\n```' }),
    );
    expect(container.querySelector('code')?.textContent).toContain('const x = 1;');
  });
});
