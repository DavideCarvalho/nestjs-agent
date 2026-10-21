// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSection, summarize } from './LiveSection';
import { ReliabilitySection } from './ReliabilitySection';
import { RunDetailPanel } from './RunDetailPanel';
import { MOCK_RELIABILITY, MOCK_RUNS_PAGE, MOCK_RUN_DETAIL } from './mock-data';
import { TooltipProvider } from './ui/tooltip';

/**
 * Run metrics on the console: how long a person waited for the first token (the Reliability page's
 * TTFT stat), what one run cost and which model answered it (the run drill-down), and every run
 * terminal — failed and cancelled as well as finished — on the live feed.
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
});

function renderReliability(overview = MOCK_RELIABILITY) {
  return render(
    <TooltipProvider>
      <ReliabilitySection
        overview={overview}
        runsTable={{ page: MOCK_RUNS_PAGE, error: null, retry: () => {} }}
        runsWhere={{}}
        onRunsStatusChange={() => {}}
        onRunsAgentNameChange={() => {}}
        onRunsThreadIdClear={() => {}}
        onRunsPageChange={() => {}}
      />
    </TooltipProvider>,
  );
}

describe('ReliabilitySection — time to first token', () => {
  it('shows the p95 TTFT with the p50 beside it', () => {
    renderReliability({
      ...MOCK_RELIABILITY,
      metrics: { ...MOCK_RELIABILITY.metrics, ttftP50Ms: 310, ttftP95Ms: 1_400 },
    });

    expect(screen.getByText('p95 TTFT')).toBeDefined();
    expect(screen.getByText('1.4s')).toBeDefined();
    expect(screen.getByText(/p50 310ms/)).toBeDefined();
  });

  it('reads as no data, not as zero, when no completed run recorded one', () => {
    renderReliability({
      ...MOCK_RELIABILITY,
      metrics: { ...MOCK_RELIABILITY.metrics, ttftP50Ms: null, ttftP95Ms: null },
    });

    expect(screen.getByText(/p50 — · completed turns/)).toBeDefined();
    expect(screen.queryByText('0ms')).toBeNull();
  });
});

describe('RunDetailPanel — the run row’s own metrics', () => {
  it('shows time to first token, cost and model when the run recorded them', () => {
    render(
      <RunDetailPanel
        detail={{
          ...MOCK_RUN_DETAIL,
          run: { ...MOCK_RUN_DETAIL.run, ttftMs: 420, costUsd: 0.25, modelId: 'gpt-x' },
        }}
      />,
    );

    expect(screen.getByText('Time to first token')).toBeDefined();
    expect(screen.getByText('420ms')).toBeDefined();
    expect(screen.getByText('$0.25')).toBeDefined();
    expect(screen.getByText('gpt-x')).toBeDefined();
  });

  it('shows no figure at all for a run that recorded none', () => {
    render(
      <RunDetailPanel
        detail={{
          ...MOCK_RUN_DETAIL,
          run: { ...MOCK_RUN_DETAIL.run, ttftMs: null, costUsd: null, modelId: null },
        }}
      />,
    );

    expect(screen.queryByText('Time to first token')).toBeNull();
    expect(screen.queryByText('Cost')).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
  });
});

describe('LiveSection — run terminals', () => {
  const at = (event: string, payload: Record<string, unknown>) => ({
    id: `${event}-1`,
    event,
    ts: Date.now(),
    payload,
  });

  it('summarizes a finished run with its TTFT, and failed / cancelled runs with code and duration', () => {
    expect(
      summarize(
        at('run.finished', {
          runId: 'r1',
          steps: 2,
          inputTokens: 10,
          outputTokens: 5,
          ttftMs: 350,
        }),
      ),
    ).toBe('run r1 finished · 2 steps · 15 tok · ttft 350ms');
    expect(
      summarize(at('run.failed', { runId: 'r2', code: 'model_no_output', durationMs: 1_500 })),
    ).toBe('run r2 failed · model_no_output after 1.5s');
    expect(summarize(at('run.cancelled', { runId: 'r3', durationMs: 900 }))).toBe(
      'run r3 cancelled after 900ms',
    );
    expect(summarize(at('run.cancelled', { runId: 'r4' }))).toBe('run r4 cancelled');
  });

  it('renders a failed run on the feed', () => {
    render(
      <LiveSection connected events={[at('run.failed', { runId: 'r2', code: 'run_failed' })]} />,
    );

    expect(screen.getByText('run.failed')).toBeDefined();
    expect(screen.getByText('run r2 failed · run_failed')).toBeDefined();
  });
});
