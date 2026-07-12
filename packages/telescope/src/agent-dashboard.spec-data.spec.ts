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
    expect(kinds).toContain('distribution');
    expect(kinds).toContain('breakdown');
  });

  it('maps the duration distribution panel to markers [p50, p95]', () => {
    const dashboard = agentDashboard();
    const duration = dashboard.sections
      ?.flatMap((s) => s.panels)
      .find((p) => p.kind === 'distribution' && p.title === 'Run duration');
    expect(duration?.kind).toBe('distribution');
    expect(duration?.kind === 'distribution' ? duration.markers : undefined).toEqual([
      'p50',
      'p95',
    ]);
  });

  it('keeps the Overview section lean (just Runs/Tokens stats)', () => {
    const dashboard = agentDashboard();
    const overview = dashboard.sections?.find((s) => s.title === 'Overview');
    expect(overview?.panels).toHaveLength(2);
  });
});
