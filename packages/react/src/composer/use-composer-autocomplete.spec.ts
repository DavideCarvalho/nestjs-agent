// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AutocompleteItem, AutocompleteSource } from './model.js';
import {
  type ComposerAutocomplete,
  type UseComposerAutocompleteOptions,
  useComposerAutocomplete,
} from './use-composer-autocomplete.js';

const SKILLS: AutocompleteItem[] = [
  { id: 'deploy', label: 'deploy', description: 'ship the current build' },
  { id: 'rollback', label: 'rollback' },
  { id: 'digest', label: 'digest', description: 'summarise a thread' },
];

function commandSource(overrides: Partial<AutocompleteSource> = {}): AutocompleteSource {
  return {
    id: 'skills',
    label: 'Skills',
    trigger: '/',
    position: 'start',
    getItems: () => SKILLS,
    ...overrides,
  };
}

let live: ComposerAutocomplete | null = null;

function autocomplete(): ComposerAutocomplete {
  if (!live) throw new Error('harness not rendered');
  return live;
}

type HarnessProps = Omit<UseComposerAutocompleteOptions, 'value' | 'onValueChange'> & {
  initial?: string;
};

/** A real textarea driven by the prop-getters, because the getters are half of the surface. */
function Harness({ initial = '', ...options }: HarnessProps) {
  const [value, setValue] = useState(initial);
  const model = useComposerAutocomplete({ ...options, value, onValueChange: setValue });
  live = model;
  const inputProps = model.getInputProps();
  return createElement(
    'div',
    null,
    createElement('textarea', {
      ...inputProps,
      'aria-label': 'draft',
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        setValue(event.target.value);
        inputProps.onChange(event);
      },
    }),
    model.isOpen
      ? createElement(
          'ul',
          { ...model.getListboxProps() },
          model.items.map((item, index) =>
            createElement('li', { key: item.id, ...model.getOptionProps(index) }, item.label),
          ),
        )
      : null,
  );
}

function draft(): HTMLTextAreaElement {
  return screen.getByLabelText('draft') as HTMLTextAreaElement;
}

function type(text: string, caret = text.length) {
  fireEvent.change(draft(), {
    target: { value: text, selectionStart: caret, selectionEnd: caret },
  });
}

/** `fireEvent` returns false when a handler called `preventDefault` — the composer's own signal. */
function press(key: string, init: Record<string, unknown> = {}): boolean {
  return !fireEvent.keyDown(draft(), { key, ...init });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useComposerAutocomplete', () => {
  it('opens on a trigger and offers what the source returned', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    expect(autocomplete().isOpen).toBe(false);

    type('/');

    expect(autocomplete().isOpen).toBe(true);
    expect(autocomplete().trigger).toBe('/');
    expect(autocomplete().items.map((item) => item.id)).toEqual(['deploy', 'rollback', 'digest']);
  });

  it('stays shut inside a path', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('src/');
    expect(autocomplete().isOpen).toBe(false);
    expect(autocomplete().items).toEqual([]);
  });

  it('narrows as the query grows and re-highlights the first match', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/');
    act(() => autocomplete().moveHighlight(1));
    expect(autocomplete().activeIndex).toBe(1);

    type('/d');

    expect(autocomplete().items.map((item) => item.id)).toEqual(['deploy', 'digest']);
    expect(autocomplete().activeIndex).toBe(0);
  });

  it('moves the highlight with the arrows and wraps at both ends', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/');

    expect(press('ArrowDown')).toBe(true);
    expect(autocomplete().activeIndex).toBe(1);
    press('ArrowUp');
    press('ArrowUp');
    expect(autocomplete().activeIndex).toBe(2);
    press('ArrowDown');
    expect(autocomplete().activeIndex).toBe(0);
  });

  it('accepts on Enter, rewriting the token and swallowing the key so nothing is sent', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/roll');

    expect(press('Enter')).toBe(true);
    expect(draft().value).toBe('/rollback ');
    expect(autocomplete().isOpen).toBe(false);
  });

  it('leaves Enter alone when no menu is open', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('ship it');
    expect(press('Enter')).toBe(false);
  });

  it('puts the caret after the inserted command and keeps the tail of the line', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/roll tail', 5);

    press('Enter');

    expect(draft().value).toBe('/rollback  tail');
    expect(draft().selectionStart).toBe(10);
  });

  it('accepts on Tab, and leaves Shift+Tab to move focus', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/dep');

    expect(press('Tab', { shiftKey: true })).toBe(false);
    expect(draft().value).toBe('/dep');

    expect(press('Tab')).toBe(true);
    expect(draft().value).toBe('/deploy ');
  });

  it('leaves Tab to focus when the host turns it off', () => {
    render(createElement(Harness, { sources: [commandSource()], acceptOnTab: false }));
    type('/dep');
    expect(press('Tab')).toBe(false);
    expect(draft().value).toBe('/dep');
  });

  it('dismisses on Escape and stays shut while the same token is edited', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/dep');

    expect(press('Escape')).toBe(true);
    expect(autocomplete().isOpen).toBe(false);
    expect(draft().value).toBe('/dep');

    type('/depl');
    expect(autocomplete().isOpen).toBe(false);
    // …and Enter is the composer's again.
    expect(press('Enter')).toBe(false);
  });

  it('reopens once the dismissed token is gone', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/dep');
    press('Escape');

    type('');
    type('/r');

    expect(autocomplete().isOpen).toBe(true);
  });

  it('ignores a slow answer that a newer query has already overtaken', async () => {
    const slow = deferred<AutocompleteItem[]>();
    const fast = deferred<AutocompleteItem[]>();
    const getItems = vi
      .fn<(query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>>()
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);
    render(createElement(Harness, { sources: [commandSource({ getItems, filter: (i) => i })] }));

    type('/d');
    type('/de');

    await act(async () => {
      fast.resolve([{ id: 'fresh', label: 'fresh' }]);
      await fast.promise;
    });
    await act(async () => {
      slow.resolve([{ id: 'stale', label: 'stale' }]);
      await slow.promise;
    });

    expect(autocomplete().items.map((item) => item.id)).toEqual(['fresh']);
  });

  it('aborts the request a newer query replaced', async () => {
    const signals: AbortSignal[] = [];
    const getItems = vi.fn(async (_query: string, signal: AbortSignal) => {
      signals.push(signal);
      return SKILLS;
    });
    render(createElement(Harness, { sources: [commandSource({ getItems })] }));

    await act(async () => {
      type('/d');
    });
    await act(async () => {
      type('/de');
    });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('keeps typing working when a source throws, and says so', async () => {
    const onError = vi.fn();
    const getItems = vi.fn(async () => {
      throw new Error('skills endpoint is down');
    });
    render(createElement(Harness, { sources: [commandSource({ getItems })], onError }));

    await act(async () => {
      type('/d');
    });

    expect(autocomplete().error).toBe('skills endpoint is down');
    expect(autocomplete().items).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);

    // The draft is untouched and Enter still belongs to the composer.
    await act(async () => {
      type('/deploy now');
    });
    expect(draft().value).toBe('/deploy now');
    expect(press('Enter')).toBe(false);
  });

  it('wires the textarea and the list as a combobox', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    const textarea = draft();
    expect(textarea.getAttribute('role')).toBe('combobox');
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    expect(textarea.getAttribute('aria-activedescendant')).toBeNull();

    type('/');

    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(textarea.getAttribute('aria-controls')).toBe(listbox.id);
    expect(listbox.getAttribute('aria-label')).toBe('Skills');

    const options = screen.getAllByRole('option');
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-selected')).toBe('false');

    press('ArrowDown');
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
  });

  it('picks by click through accept, not only by keyboard', () => {
    render(createElement(Harness, { sources: [commandSource()] }));
    type('/');

    act(() => autocomplete().accept(SKILLS[2]));

    expect(draft().value).toBe('/digest ');
  });
});
