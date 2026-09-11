// @vitest-environment jsdom
import type { AutocompleteSource } from '@dudousxd/nestjs-agent-react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './chat-composer';

const SKILLS = [
  { id: 'deploy', label: 'deploy', description: 'ship the current build' },
  { id: 'digest', label: 'digest' },
  { id: 'rollback', label: 'rollback' },
];

/** The skills source the other half of the stack will supply — here, a fake of the same shape. */
function skills(overrides: Partial<AutocompleteSource> = {}): AutocompleteSource {
  return {
    id: 'skills',
    label: 'Skills',
    trigger: '/',
    position: 'start',
    getItems: () => SKILLS,
    ...overrides,
  };
}

function draft(): HTMLTextAreaElement {
  return screen.getByLabelText('Ask anything') as HTMLTextAreaElement;
}

function type(text: string) {
  fireEvent.change(draft(), { target: { value: text } });
}

describe('ChatComposer autocomplete', () => {
  it('opens on a slash typed first and lists what the source offers', () => {
    render(<ChatComposer onSubmit={() => undefined} autocompleteSources={[skills()]} />);

    type('/');

    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('Skills');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'deployship the current build',
      'digest',
      'rollback',
    ]);
  });

  it('leaves a path alone', () => {
    render(<ChatComposer onSubmit={() => undefined} autocompleteSources={[skills()]} />);
    type('look at src/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('never opens for a composer given no sources', () => {
    render(<ChatComposer onSubmit={() => undefined} />);
    type('/deploy');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks on Enter instead of sending, then sends the completed line', () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} autocompleteSources={[skills()]} />);

    type('/roll');
    fireEvent.keyDown(draft(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(draft().value).toBe('/rollback ');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/rollback');
  });

  it('moves the highlight with the arrows and points the textarea at it', () => {
    render(<ChatComposer onSubmit={() => undefined} autocompleteSources={[skills()]} />);
    type('/');

    const options = screen.getAllByRole('option');
    expect(draft().getAttribute('aria-activedescendant')).toBe(options[0]?.id);

    fireEvent.keyDown(draft(), { key: 'ArrowDown' });
    expect(draft().getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('inserts the row that was clicked', () => {
    render(<ChatComposer onSubmit={() => undefined} autocompleteSources={[skills()]} />);
    type('/d');

    fireEvent.click(screen.getAllByRole('option')[1] as HTMLElement);

    expect(draft().value).toBe('/digest ');
  });

  it('dismisses on Escape and gives Enter back to the composer', () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} autocompleteSources={[skills()]} />);

    type('/roll');
    fireEvent.keyDown(draft(), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/roll');
  });

  it('shows where each item came from, and says when one overrides another', () => {
    const scoped = skills({
      getItems: () => [
        { id: 'normalize-unit', label: 'normalize-unit', hint: 'tenant:base-7 · overrides global' },
        { id: 'work-order', label: 'work-order', hint: 'global' },
      ],
    });
    render(<ChatComposer onSubmit={() => undefined} autocompleteSources={[scoped]} />);

    type('/');

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'normalize-unittenant:base-7 · overrides global',
      'work-orderglobal',
    ]);
  });

  it('tells "nothing is configured for you" from "nothing matched what you typed"', () => {
    const empty = skills({ getItems: () => [] });
    render(<ChatComposer onSubmit={() => undefined} autocompleteSources={[empty]} />);

    type('/');
    expect(screen.getByText('Nothing to complete')).toBeTruthy();

    type('/zzz');
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('says so when nothing matches, and still sends what was typed', () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} autocompleteSources={[skills()]} />);

    type('/zzz');

    expect(screen.getByText('No matches')).toBeTruthy();
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/zzz');
  });

  it('keeps the composer usable when the source fails', async () => {
    const onSubmit = vi.fn();
    const failing = skills({
      getItems: async () => {
        throw new Error('skills endpoint is down');
      },
    });
    render(<ChatComposer onSubmit={onSubmit} autocompleteSources={[failing]} />);

    await act(async () => {
      type('/dep');
    });

    expect(screen.getByText('skills endpoint is down')).toBeTruthy();
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/dep');
  });

  it('leaves a composer without sources sending on Enter exactly as before', () => {
    const onSubmit = vi.fn();
    render(<ChatComposer onSubmit={onSubmit} />);
    type('ship it');
    fireEvent.keyDown(draft(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('ship it');
  });
});
