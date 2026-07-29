// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useSuspenseQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SectionBoundary } from './SectionBoundary';

/**
 * The behaviour this file exists to pin down is the one the console did NOT have: a query that
 * fails has to say so, in its own section, without taking the rest of the page with it. Before the
 * boundary, ten of the eleven queries failed silently into an empty state that reads as "no data".
 */

function client(): QueryClient {
  // `retry: false` so a deliberate failure fails once — the retry POLICY is not what is under test.
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** A section whose read rejects until `succeedAfter` attempts have been made. */
function Section({
  label,
  attempts,
}: { label: string; attempts: { count: number; until: number } }) {
  const query = useSuspenseQuery({
    queryKey: [label],
    queryFn: async () => {
      attempts.count += 1;
      if (attempts.count <= attempts.until) throw new Error('503 Service Unavailable');
      return `${label} loaded`;
    },
  });
  return <div>{query.data}</div>;
}

function Healthy() {
  const query = useSuspenseQuery({ queryKey: ['healthy'], queryFn: async () => 'healthy loaded' });
  return <div>{query.data}</div>;
}

describe('SectionBoundary', () => {
  beforeEach(() => {
    // `componentDidCatch` logs; React also logs the caught error itself. Neither is a test failure.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('names the failing section, shows what the server said, and offers a retry', async () => {
    const queryClient = client();
    render(
      <Wrapper queryClient={queryClient}>
        <SectionBoundary label="Spend & usage">
          <Section label="spend" attempts={{ count: 0, until: 99 }} />
        </SectionBoundary>
      </Wrapper>,
    );

    expect(await screen.findByText('Spend & usage failed to load')).toBeTruthy();
    expect(screen.getByText('503 Service Unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('does not blank a sibling section when one fails', async () => {
    const queryClient = client();
    render(
      <Wrapper queryClient={queryClient}>
        <SectionBoundary label="Spend & usage">
          <Section label="spend" attempts={{ count: 0, until: 99 }} />
        </SectionBoundary>
        <SectionBoundary label="Reliability">
          <Healthy />
        </SectionBoundary>
      </Wrapper>,
    );

    expect(await screen.findByText('Spend & usage failed to load')).toBeTruthy();
    expect(await screen.findByText('healthy loaded')).toBeTruthy();
  });

  it('retries the failed read and renders it once it succeeds', async () => {
    const queryClient = client();
    const attempts = { count: 0, until: 1 };
    render(
      <Wrapper queryClient={queryClient}>
        <SectionBoundary label="Spend & usage">
          <Section label="spend" attempts={attempts} />
        </SectionBoundary>
      </Wrapper>,
    );

    const retry = await screen.findByRole('button', { name: /retry/i });
    retry.click();

    await waitFor(() => expect(screen.getByText('spend loaded')).toBeTruthy());
    expect(attempts.count).toBe(2);
  });

  it('shows the section skeleton while the read is in flight', async () => {
    const queryClient = client();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    function Slow() {
      const query = useSuspenseQuery({
        queryKey: ['slow'],
        queryFn: async () => {
          await gate;
          return 'slow loaded';
        },
      });
      return <div>{query.data}</div>;
    }

    render(
      <Wrapper queryClient={queryClient}>
        <SectionBoundary label="Reliability">
          <Slow />
        </SectionBoundary>
      </Wrapper>,
    );

    expect(await screen.findByText('Loading reliability…')).toBeTruthy();
    release?.();
    await waitFor(() => expect(screen.getByText('slow loaded')).toBeTruthy());
  });

  it('renders a render-time throw, not only a failed query', async () => {
    const queryClient = client();
    function Broken(): never {
      throw new Error('Cannot read properties of undefined');
    }
    // A component that throws on FIRST render, so the boundary is the only thing between a bad
    // read-model row and a blank console.
    function Mounted() {
      useEffect(() => {}, []);
      return <Broken />;
    }

    render(
      <Wrapper queryClient={queryClient}>
        <SectionBoundary label="Models">
          <Mounted />
        </SectionBoundary>
      </Wrapper>,
    );

    expect(await screen.findByText('Models failed to load')).toBeTruthy();
    expect(screen.getByText('Cannot read properties of undefined')).toBeTruthy();
  });
});
