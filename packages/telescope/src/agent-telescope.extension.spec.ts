import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { agentTelescopeExtension } from './agent-telescope.extension.js';

const ctx = { config: {}, moduleRef: {} } as unknown as ExtensionContext;

describe('agentTelescopeExtension', () => {
  it('bundles the watcher, entry type, dashboard, and all providers', () => {
    const ext = agentTelescopeExtension();
    expect(ext.name).toBe('agent');
    expect(ext.watchers?.(ctx).map((w) => w.type)).toEqual(['agent']);
    expect(ext.entryTypes?.(ctx)).toEqual([{ id: 'agent', label: 'Agent', dot: 'bg-violet-400' }]);
    expect(ext.dashboards?.(ctx).map((d) => d.id)).toEqual(['agent.overview']);
    expect(
      ext
        .dataProviders?.(ctx)
        .map((p) => p.name)
        .sort(),
    ).toEqual(
      [
        'agent.approvals.pending',
        'agent.approvals.recent',
        'agent.runs',
        'agent.runs.byAgent',
        'agent.runs.duration',
        'agent.runs.errors',
        'agent.runs.failed',
        'agent.runs.paged',
        'agent.runs.recent',
        'agent.runs.retries',
        'agent.runs.successRate',
        'agent.runs.total',
        'agent.runs.trend',
        'agent.spend.byActor',
        'agent.spend.byActorShare',
        'agent.spend.byModel',
        'agent.spend.byModelTable',
        'agent.spend.totalCost',
        'agent.spend.totalTokens',
        'agent.threads.paged',
        'agent.threads.recent',
        'agent.threads.topSpend',
        'agent.tokens',
        'agent.toolStatus',
        'agent.tools.paged',
        'agent.tools.recent',
        'agent.tools.stats',
        'agent.usage.trend',
      ].sort(),
    );
    // The ephemeral, watcher-fed 'agent.tools' provider is NOT in the shipped extension — retired
    // in favour of the durable 'agent.tools.recent' (see agent-data-providers.ts's @deprecated note).
    expect(ext.dataProviders?.(ctx).map((p) => p.name)).not.toContain('agent.tools');
  });

  it('passes threadHref/runHref through to the dashboard for Column.link deep-links', () => {
    const withHrefs = agentTelescopeExtension({
      threadHref: '/agent/threads/{threadId}',
      runHref: '/agent/runs/{runId}',
    });
    const dashboard = withHrefs.dashboards?.(ctx)[0];
    const panels = dashboard?.sections?.flatMap((s) => s.panels) ?? [];
    const recentRuns = panels.find((p) => p.kind === 'table' && p.title === 'Recent runs');
    expect(recentRuns?.kind).toBe('table');
    const runIdColumn =
      recentRuns?.kind === 'table' ? recentRuns.columns.find((c) => c.key === 'runId') : undefined;
    expect(runIdColumn?.link).toEqual({ href: '/agent/runs/{runId}' });
    // The slimmed recent-runs table has no threadId column; the thread deep-link lives on the
    // thread-bearing tables (recently active threads, approvals inbox, recent tool calls).
    const recentThreads = panels.find(
      (p) => p.kind === 'table' && p.title === 'Recently active threads',
    );
    const threadIdColumn =
      recentThreads?.kind === 'table'
        ? recentThreads.columns.find((c) => c.key === 'threadId')
        : undefined;
    expect(threadIdColumn?.link).toEqual({ href: '/agent/threads/{threadId}' });

    // No opts.runHref → the runId column still links, defaulting to the in-app trace waterfall
    // (no host wiring needed); no opts.threadHref → the threadId column stays plain text (there's
    // no internal thread view to default to).
    const withoutHrefs = agentTelescopeExtension();
    const plainDashboard = withoutHrefs.dashboards?.(ctx)[0];
    const plainRecentRuns = plainDashboard?.sections
      ?.flatMap((s) => s.panels)
      .find((p) => p.kind === 'table' && p.title === 'Recent runs');
    const plainRunIdColumn =
      plainRecentRuns?.kind === 'table'
        ? plainRecentRuns.columns.find((c) => c.key === 'runId')
        : undefined;
    expect(plainRunIdColumn?.link).toEqual({ href: '#/traces/{runId}' });

    const plainRecentThreads = plainDashboard?.sections
      ?.flatMap((s) => s.panels)
      .find((p) => p.kind === 'table' && p.title === 'Recently active threads');
    const plainThreadIdColumn =
      plainRecentThreads?.kind === 'table'
        ? plainRecentThreads.columns.find((c) => c.key === 'threadId')
        : undefined;
    expect(plainThreadIdColumn?.link).toBeUndefined();
  });
});
