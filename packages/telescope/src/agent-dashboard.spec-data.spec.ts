import { describe, expect, it } from 'vitest';
import { agentDashboard } from './agent-dashboard.spec-data.js';

describe('agentDashboard', () => {
  it('is sectioned into the eight named groups, merging the old Reliability/Run-trends split', () => {
    const dashboard = agentDashboard();
    const titles = dashboard.sections?.map((s) => s.title) ?? [];
    expect(titles).toEqual([
      'Overview',
      'Spend',
      'Reliability',
      'Activity',
      'Approvals',
      'Tools',
      'Retrieval',
      'Retrieval sources',
    ]);
    const kinds = dashboard.sections?.flatMap((s) => s.panels.map((p) => p.kind)) ?? [];
    expect(kinds).toContain('breakdown');
  });

  it('has no distribution panel outside RAG — RunMetrics carries no raw samples to bucket', () => {
    const dashboard = agentDashboard();
    const distributions =
      dashboard.sections
        ?.filter((s) => s.title !== 'Retrieval')
        .flatMap((s) => s.panels.map((p) => p.kind)) ?? [];
    expect(distributions).not.toContain('distribution');
  });

  it('every section renders a whole number of rows for its own `cols` — no orphan half-width panel', () => {
    const dashboard = agentDashboard();
    for (const section of dashboard.sections ?? []) {
      const cols = section.cols ?? 2;
      expect(section.panels.length % cols).toBe(0);
    }
  });

  it('renders run duration as p50/p95 stat panels bound by query.metric', () => {
    const dashboard = agentDashboard();
    const panels = dashboard.sections?.flatMap((s) => s.panels) ?? [];
    const p50 = panels.find((p) => p.title === 'Duration p50');
    const p95 = panels.find((p) => p.title === 'Duration p95');
    expect(p50?.kind).toBe('stat');
    expect(p50?.data).toEqual({ provider: 'agent.runs.duration', query: { metric: 'p50' } });
    expect(p95?.kind).toBe('stat');
    expect(p95?.data).toEqual({ provider: 'agent.runs.duration', query: { metric: 'p95' } });
  });

  it('keeps the recent-runs table slim (7 columns; detail lives in the standalone dashboard)', () => {
    const dashboard = agentDashboard();
    const recentRuns = dashboard.sections
      ?.flatMap((s) => s.panels)
      .find((p) => p.kind === 'table' && p.title === 'Recent runs');
    const keys = recentRuns?.kind === 'table' ? recentRuns.columns.map((column) => column.key) : [];
    expect(keys).toEqual([
      'startedAt',
      'runId',
      'agentName',
      'status',
      'durationMs',
      'errorMessage',
      'promptHash',
    ]);
  });

  it('keeps the Overview section lean (Runs/Tokens/Success rate stats only)', () => {
    const dashboard = agentDashboard();
    const overview = dashboard.sections?.find((s) => s.title === 'Overview');
    expect(overview?.panels).toHaveLength(3);
    expect(overview?.panels.map((p) => p.title)).toEqual(['Runs', 'Tokens', 'Success rate']);
  });

  it('the Activity section adopts the three paged providers (A1) for its list tables', () => {
    const dashboard = agentDashboard();
    const activity = dashboard.sections?.find((s) => s.title === 'Activity');
    const providers = activity?.panels.map((p) => p.data.provider);
    expect(providers).toEqual(['agent.runs.paged', 'agent.tools.paged', 'agent.threads.paged']);
  });

  it('a runId column defaults to the in-app trace route, overridable via opts.runHref', () => {
    const runIdColumn = (panels: ReturnType<typeof agentDashboard>['sections']) =>
      panels
        ?.flatMap((s) => s.panels)
        .filter((p): p is Extract<typeof p, { kind: 'table' }> => p.kind === 'table')
        .flatMap((p) => p.columns)
        .find((c) => c.key === 'runId');

    const defaultDashboard = agentDashboard();
    expect(runIdColumn(defaultDashboard.sections)?.link).toEqual({ href: '#/traces/{runId}' });

    const customDashboard = agentDashboard({ runHref: '/custom/runs/{runId}' });
    expect(runIdColumn(customDashboard.sections)?.link).toEqual({
      href: '/custom/runs/{runId}',
    });
  });

  it('the RAG sections bind only to providers the retrieval telemetry actually feeds', () => {
    const dashboard = agentDashboard();
    const rag = dashboard.sections?.filter(
      (s) => s.title === 'Retrieval' || s.title === 'Retrieval sources',
    );
    expect(rag?.flatMap((s) => s.panels.map((p) => p.data.provider))).toEqual([
      'agent.rag.retrievals',
      'agent.rag.zeroHitRate',
      'agent.rag.chunks',
      'agent.rag.latency',
      'agent.rag.scores',
      'agent.rag.trend',
      'agent.rag.byStore',
      'agent.rag.byRetriever',
      'agent.rag.byCollection',
      'agent.rag.slowest',
    ]);
  });

  it('scopes the score histogram to one retriever kind — scores share no scale across strategies', () => {
    const dashboard = agentDashboard();
    const scores = dashboard.sections
      ?.flatMap((s) => s.panels)
      .find((p) => p.data.provider === 'agent.rag.scores');
    expect(scores?.kind).toBe('distribution');
    expect(scores?.data.query).toEqual({ retriever: 'embedding' });
  });

  it('appends host-contributed sections after every built-in one, unaltered', () => {
    const hostSection = {
      title: 'Knowledge base',
      cols: 2 as const,
      panels: [
        {
          kind: 'stat' as const,
          title: 'Collections',
          data: { provider: 'myapp.rag.collections' },
        },
        { kind: 'stat' as const, title: 'Documents', data: { provider: 'myapp.rag.documents' } },
      ],
    };
    const dashboard = agentDashboard({ sections: [hostSection] });
    expect(dashboard.sections?.at(-1)).toEqual(hostSection);
    expect(dashboard.sections?.map((s) => s.title).slice(0, 8)).toEqual(
      agentDashboard().sections?.map((s) => s.title),
    );
  });

  it('a threadId column has no link by default (host-only, no internal thread view)', () => {
    const dashboard = agentDashboard();
    const threadIdColumns = dashboard.sections
      ?.flatMap((s) => s.panels)
      .filter((p): p is Extract<typeof p, { kind: 'table' }> => p.kind === 'table')
      .flatMap((p) => p.columns)
      .filter((c) => c.key === 'threadId');
    expect(threadIdColumns?.every((c) => c.link === undefined)).toBe(true);

    const withThreadHref = agentDashboard({ threadHref: '/host/threads/{threadId}' });
    const threadIdColumnsWithHref = withThreadHref.sections
      ?.flatMap((s) => s.panels)
      .filter((p): p is Extract<typeof p, { kind: 'table' }> => p.kind === 'table')
      .flatMap((p) => p.columns)
      .filter((c) => c.key === 'threadId');
    expect(threadIdColumnsWithHref?.every((c) => c.link?.href === '/host/threads/{threadId}')).toBe(
      true,
    );
  });
});
