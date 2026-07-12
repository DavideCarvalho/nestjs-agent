import { describe, expect, it } from 'vitest';
import { agentDashboard } from './agent-dashboard.spec-data.js';

describe('agentDashboard', () => {
  it('is sectioned with a Reliability row and Run-trends section', () => {
    const dashboard = agentDashboard();
    const titles = dashboard.sections?.map((s) => s.title) ?? [];
    expect(titles).toContain('Reliability');
    expect(titles).toContain('Run trends');
    expect(titles).toContain('Approvals');
    const kinds = dashboard.sections?.flatMap((s) => s.panels.map((p) => p.kind)) ?? [];
    expect(kinds).toContain('breakdown');
    // No distribution panel: RunMetrics has no raw duration samples, so a histogram would render
    // as a permanently-empty box — duration is two stat panels instead.
    expect(kinds).not.toContain('distribution');
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

  it('keeps the Overview section lean (just Runs/Tokens stats)', () => {
    const dashboard = agentDashboard();
    const overview = dashboard.sections?.find((s) => s.title === 'Overview');
    expect(overview?.panels).toHaveLength(2);
  });
});
