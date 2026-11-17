// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../aviary-kit/url-state/nuqs-hash-adapter';
import { agentClient } from '../client/agent-client';
import { App } from './App';
import { ReliabilityContainer } from './containers/ReliabilityContainer';
import { MOCK_RELIABILITY, MOCK_RUNS_PAGE } from './mock-data';
import { TooltipProvider } from './ui/tooltip';
import { pageParam, sharedSearch } from './url-state';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Point the test environment at `url` without a navigation. */
function goTo(url: string) {
  window.history.replaceState(null, '', url);
}

/**
 * Reliability's two reads answer with fixtures; every other read answers "not served", so a section
 * renders its inline error: the URL is what these tests look at.
 */
function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/reliability?')) return Response.json(MOCK_RELIABILITY);
    if (url.includes('/runs?')) return Response.json(MOCK_RUNS_PAGE);
    return new Response('{}', { status: 501, statusText: 'Not Implemented' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The decoded URLs fetched so far that read `path`. */
function reads(fetchMock: ReturnType<typeof stubFetch>, path: string): string[] {
  return fetchMock.mock.calls
    .map(([url]) => decodeURIComponent(String(url)))
    .filter((url) => url.includes(path));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterEach(async () => {
  cleanup();
  // nuqs flushes URL writes on a short throttle; let a queued one land before the next test.
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Reliability: the runs table filters live in the URL', () => {
  function renderReliability() {
    return renderWithClient(
      <NuqsHashAdapter>
        <ReliabilityContainer range={{ fromDay: '2026-07-01', toDay: '2026-07-30' }} />
      </NuqsHashAdapter>,
    );
  }

  it('opens filtered and paged from a shared link', async () => {
    const fetchMock = stubFetch();
    goTo('/ai-gateway#/reliability?status=failed&agent=support&threadId=th2&page=2');
    renderReliability();
    await waitFor(() => expect(reads(fetchMock, '/runs?').length).toBeGreaterThan(0));
    const url = reads(fetchMock, '/runs?').at(-1) ?? '';
    expect(url).toContain('page=2');
    expect(url).toContain('filter[status]=failed');
    expect(url).toContain('filter[agentName]=support');
    expect(url).toContain('filter[threadId]=th2');
    expect((screen.getByPlaceholderText('agent') as HTMLInputElement).value).toBe('support');
  });

  it('typing a filter rewrites the history entry and goes back to page 1', async () => {
    stubFetch();
    goTo('/ai-gateway?tenant=acme#/reliability?page=3');
    renderReliability();
    const start = window.history.length;
    fireEvent.change(await screen.findByPlaceholderText('agent'), { target: { value: 'billing' } });
    await waitFor(() => expect(window.location.hash).toBe('#/reliability?agent=billing'));
    expect(window.history.length).toBe(start);
    // the page's own query belongs to the server and is kept
    expect(window.location.pathname).toBe('/ai-gateway');
    expect(window.location.search).toBe('?tenant=acme');
  });
});

describe('App: the day range lives in the URL and follows the operator across sections', () => {
  it('reads the range from the URL and carries it to the next section', async () => {
    const fetchMock = stubFetch();
    vi.spyOn(agentClient, 'streamEvents').mockReturnValue(() => {});
    goTo('/ai-gateway#/spend?from=2026-07-01&to=2026-07-10');
    renderWithClient(<App />);
    expect((await screen.findAllByText('2026-07-01 → 2026-07-10')).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        reads(fetchMock, 'from=2026-07-01').length + reads(fetchMock, 'fromDay=2026-07-01').length,
      ).toBeGreaterThan(0),
    );

    // Every nav link carries the range, so open-in-new-tab and copy-link keep it too.
    const models = screen.getAllByText('Models')[0]?.closest('a');
    expect(models?.getAttribute('href')).toBe('#/models?from=2026-07-01&to=2026-07-10');
    // happy-dom follows an anchor's href before React's (delegated) click handler can cancel it,
    // which a browser does not: cancel the default up front so the nav's own handler runs, as in a
    // browser.
    const cancel = (event: Event) => event.preventDefault();
    document.addEventListener('click', cancel, { capture: true });
    fireEvent.click(screen.getAllByText('Models')[0] as HTMLElement);
    document.removeEventListener('click', cancel, { capture: true });
    await waitFor(() =>
      expect(window.location.hash).toBe('#/models?from=2026-07-01&to=2026-07-10'),
    );
  });
});

describe('pageParam', () => {
  it('takes a whole page from 1 up and ignores anything else', () => {
    expect(pageParam.parse('3')).toBe(3);
    expect(pageParam.parse('0')).toBeNull();
    expect(pageParam.parse('-2')).toBeNull();
    expect(pageParam.parse('2.5')).toBeNull();
    expect(pageParam.parse('x')).toBeNull();
  });
});

describe('sharedSearch', () => {
  it('keeps only the topbar params', () => {
    expect(sharedSearch('#/reliability?status=failed&from=2026-07-01&to=2026-07-10&page=2')).toBe(
      'from=2026-07-01&to=2026-07-10',
    );
    expect(sharedSearch('#/reliability?status=failed')).toBe('');
    expect(sharedSearch('')).toBe('');
  });
});
