// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSearch, sanitizeSearchAnswer } from './ConsoleSearch';
import { ConsoleSwitcher, resetSwitcherCache } from './ConsoleSwitcher';
import { drillTargetFromHash } from './drill-down';

const ENDPOINT = '/ai-gateway/api/consoles/search';

function serve(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Palette({ navigate }: { navigate?: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <ConsoleSearch
      endpoint={ENDPOINT}
      open={open}
      onOpenChange={setOpen}
      {...(navigate !== undefined ? { navigate } : {})}
    />
  );
}

async function type(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search all consoles' }), {
    target: { value },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetSwitcherCache();
});

describe('ConsoleSearch', () => {
  it('opens on Ctrl/Cmd-K, asks the endpoint after typing, and groups hits per console', async () => {
    vi.useFakeTimers();
    const fetchMock = serve({
      version: 1,
      q: 'run',
      partial: true,
      results: [
        {
          id: 'durable',
          title: 'Workflows',
          icon: 'workflow',
          hits: [{ title: 'Run run-1', subtitle: 'running', href: '/durable#/runs/run-1' }],
        },
      ],
    });
    render(<Palette />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Search all consoles' })).toBeTruthy();

    await type('run 1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ENDPOINT}?q=run%201`);
    const group = screen.getByRole('group', { name: 'Workflows' });
    expect(group.textContent).toContain('Run run-1');
    expect(screen.getByRole('option').getAttribute('href')).toBe('/durable#/runs/run-1');
    expect(screen.getByRole('status').textContent).toContain('did not answer in time');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes to the first hit on Enter, and says when nothing matched', async () => {
    vi.useFakeTimers();
    serve({
      results: [
        { id: 'agent', title: 'Agents', icon: 'agent', hits: [{ title: 'A', href: '/a' }] },
      ],
    });
    const navigate = vi.fn();
    render(<Palette navigate={navigate} />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await type('a');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/a');

    serve({ results: [], partial: false });
    await type('zzz');
    expect(screen.getByText('No results.')).toBeTruthy();
  });

  it('drops unsafe hrefs and malformed groups', () => {
    expect(
      sanitizeSearchAnswer({
        partial: false,
        results: [
          { id: 'x', title: 'X', icon: 'nope', hits: [{ title: 'bad', href: '//evil.test' }] },
          { id: 'y', title: 'Y', icon: 'media', hits: [{ title: 'ok', href: '/y' }, 'junk'] },
          { title: 'no id', hits: [] },
        ],
      }),
    ).toEqual({
      partial: false,
      results: [{ id: 'y', title: 'Y', icon: 'media', hits: [{ title: 'ok', href: '/y' }] }],
    });
  });
});

describe('the switcher menu', () => {
  it('offers the search when given one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              current: 'agent',
              consoles: [{ id: 'durable', title: 'Workflows', icon: 'workflow', href: '/d' }],
            }),
          ),
      ),
    );
    const onSearch = vi.fn();
    render(
      <ConsoleSwitcher
        brand={<span>AI gateway</span>}
        current={{ title: 'Agents', icon: 'agent' }}
        config={{ endpoint: '/ai-gateway/api/consoles', others: 1 }}
        onSearch={onSearch}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: /switch console/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Search all consoles/ }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});

describe('drill-down deep links', () => {
  it('reads a run or a thread from the hash route', () => {
    expect(drillTargetFromHash('#/runs?run=run-1')).toEqual({ kind: 'run', runId: 'run-1' });
    expect(drillTargetFromHash('#/runs?thread=a%2Fb')).toEqual({ kind: 'thread', threadId: 'a/b' });
    expect(drillTargetFromHash('#/runs')).toBeUndefined();
    expect(drillTargetFromHash('#/nope?run=x')).toBeUndefined();
  });
});
