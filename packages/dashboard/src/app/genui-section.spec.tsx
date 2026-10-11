// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCount } from '../client/format-usd';
import { GenuiSection } from './GenuiSection';
import { GenuiContainer } from './containers/GenuiContainer';
import { MOCK_GENUI_EMPTY, MOCK_GENUI_STATS } from './mock-data';
import { TooltipProvider } from './ui/tooltip';

/**
 * The Generative UI page answers four questions: does the model get UI right on the first try (per
 * tool and model), which mistakes does it keep making, what does it cost, and how long does a user
 * wait. It also has two states that must not be confused with each other: a range with no UI calls,
 * and a store that does not record UI telemetry at all.
 */

beforeAll(() => {
  // Recharts' ResponsiveContainer measures with ResizeObserver, which jsdom does not provide.
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  // Recharts warns that a jsdom container measures 0×0 — true, and not what is under test.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSection(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/** The Stat tile carrying `label`, so its value can be read without matching a sibling tile. */
function tile(label: string): HTMLElement {
  const labelNode = screen.getByText(label, { selector: 'div' });
  const card = labelNode.parentElement;
  if (card === null) throw new Error(`no tile for ${label}`);
  return card;
}

describe('GenuiSection', () => {
  it('renders the KPI tiles from the totals, cost per turn and latency', () => {
    renderSection(<GenuiSection stats={MOCK_GENUI_STATS} />);

    expect(
      within(tile('UI calls')).getByText(formatCount(MOCK_GENUI_STATS.totals.calls)),
    ).toBeTruthy();
    expect(
      within(tile('Turns')).getByText(formatCount(MOCK_GENUI_STATS.totals.turns)),
    ).toBeTruthy();
    // 842 / 1014 → 83%.
    expect(within(tile('First-try success')).getByText('83%')).toBeTruthy();
    expect(within(tile('First-try success')).getByText('842 of 1014 first attempts')).toBeTruthy();
    expect(within(tile('Retried')).getByText('131')).toBeTruthy();
    expect(within(tile('Failed')).getByText('207')).toBeTruthy();
    expect(within(tile('Cost / turn')).getByText('$0.02')).toBeTruthy();
    expect(within(tile('Cost / turn')).getByText('avg · p50 $0.01 · p95 $0.04')).toBeTruthy();
    expect(within(tile('Time to first frame')).getByText('740ms')).toBeTruthy();
    expect(within(tile('Time to first frame')).getByText(/p95 2\.3s · 1002 turns/)).toBeTruthy();
    expect(within(tile('Time to complete')).getByText('3.5s')).toBeTruthy();
    expect(within(tile('Time to complete')).getByText(/p95 9\.1s/)).toBeTruthy();
  });

  it('lists first-try success per tool and model, with an unpriced cost as a dash', () => {
    renderSection(<GenuiSection stats={MOCK_GENUI_STATS} />);

    const panel = screen.getByText('First-try success by tool and model').closest('.rise');
    if (!(panel instanceof HTMLElement)) throw new Error('no tool/model panel');
    const rows = within(panel).getAllByRole('row');
    // Header + one row per tool/model.
    expect(rows).toHaveLength(1 + MOCK_GENUI_STATS.byToolModel.length);

    const renderRow = rows[1];
    if (renderRow === undefined) throw new Error('no first row');
    // Tool, model (ARN shortened), mode, calls, first attempts, rate (461/498 → 93%), retried,
    // failed, cost.
    expect(within(renderRow).getByText('ui__render')).toBeTruthy();
    expect(within(renderRow).getByText('claude-sonnet-4-5')).toBeTruthy();
    expect(within(renderRow).getByText('tree')).toBeTruthy();
    expect(within(renderRow).getByText('612')).toBeTruthy();
    expect(within(renderRow).getByText('498')).toBeTruthy();
    expect(within(renderRow).getByText('93%')).toBeTruthy();
    expect(within(renderRow).getByText('$6.84')).toBeTruthy();

    const unpriced = rows[4];
    if (unpriced === undefined) throw new Error('no fourth row');
    expect(within(unpriced).getByText('ui__show')).toBeTruthy();
    expect(within(unpriced).getByText('—')).toBeTruthy();
  });

  it('lists the common errors with their category, tool, message and count', () => {
    renderSection(<GenuiSection stats={MOCK_GENUI_STATS} />);

    const panel = screen.getByText('Common errors').closest('.rise');
    if (!(panel instanceof HTMLElement)) throw new Error('no errors panel');
    const rows = within(panel).getAllByRole('row');
    expect(rows).toHaveLength(1 + MOCK_GENUI_STATS.errors.length);

    const first = rows[1];
    if (first === undefined) throw new Error('no first error row');
    expect(within(first).getByText('syntax')).toBeTruthy();
    expect(within(first).getByText('ui__sandbox')).toBeTruthy();
    expect(
      within(first).getByText(
        'invalid Sandbox code: jsx line 14:22: Unexpected token — check that every JSX tag is closed in order',
      ),
    ).toBeTruthy();
    expect(within(first).getByText('48')).toBeTruthy();
    expect(within(first).getByText('12m ago')).toBeTruthy();
  });

  it('draws the UI cost per day', () => {
    renderSection(<GenuiSection stats={MOCK_GENUI_STATS} />);

    expect(screen.getByText('UI cost per day')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Cost' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Tokens' })).toBeTruthy();
  });

  it('says so when the range has no UI calls, instead of a page of zeroes', () => {
    renderSection(<GenuiSection stats={MOCK_GENUI_EMPTY} />);

    expect(screen.getByText('No generative-UI calls in this range')).toBeTruthy();
    expect(screen.queryByText('First-try success by tool and model')).toBeNull();
    expect(screen.queryByText('UI calls')).toBeNull();
  });

  it('says so when the store does not record generative-UI telemetry', () => {
    renderSection(<GenuiSection stats={null} unavailable />);

    expect(screen.getByText(/does not record generative-UI telemetry/)).toBeTruthy();
    expect(screen.queryByText('No generative-UI calls in this range')).toBeNull();
  });

  it('shows an empty errors table rather than hiding it when nothing was refused', () => {
    renderSection(<GenuiSection stats={{ ...MOCK_GENUI_STATS, errors: [] }} />);

    expect(screen.getByText('Common errors')).toBeTruthy();
    expect(screen.getByText('No UI errors in this range')).toBeTruthy();
  });
});

describe('GenuiContainer', () => {
  function renderContainer() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <GenuiContainer range={{ fromDay: '2026-07-01', toDay: '2026-07-30' }} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  function stubFetch(response: () => Response) {
    const fetchMock = vi.fn(async (_url: string) => response());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads GET genui with the range and renders the stats', async () => {
    const fetchMock = stubFetch(
      () => new Response(JSON.stringify(MOCK_GENUI_STATS), { status: 200 }),
    );
    renderContainer();

    expect(await screen.findByText('First-try success by tool and model')).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/ai-gateway/api/genui?from=2026-07-01&to=2026-07-30',
    );
  });

  it('renders the unsupported-store state for a 501, not an error panel', async () => {
    stubFetch(() => new Response('{}', { status: 501, statusText: 'Not Implemented' }));
    renderContainer();

    expect(await screen.findByText(/does not record generative-UI telemetry/)).toBeTruthy();
    expect(screen.queryByText(/failed to load/)).toBeNull();
  });

  it('names any other failure with the section error panel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => new Response('{}', { status: 500, statusText: 'Internal Server Error' }));
    renderContainer();

    expect(await screen.findByText('Generative UI failed to load')).toBeTruthy();
  });
});
