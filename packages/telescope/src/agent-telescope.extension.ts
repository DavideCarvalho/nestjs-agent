import type { DashboardSection, DataProvider } from '@dudousxd/nestjs-telescope';
import { defineTelescopeExtension } from '@dudousxd/nestjs-telescope';
import { agentDashboard } from './agent-dashboard.spec-data.js';
import {
  agentRunsProvider,
  agentTokensProvider,
  agentToolStatusProvider,
} from './agent-data-providers.js';
import {
  agentActorSpendTableProvider,
  agentModelSpendTableProvider,
  agentPendingApprovalsCountProvider,
  agentPendingApprovalsTableProvider,
  agentRecentRunsTableProvider,
  agentRecentThreadsTableProvider,
  agentRecentToolCallsTableProvider,
  agentRunErrorsProvider,
  agentRunsByAgentTableProvider,
  agentRunsDurationProvider,
  agentRunsFailedProvider,
  agentRunsPagedTableProvider,
  agentRunsRetriesProvider,
  agentRunsSuccessRateProvider,
  agentRunsTotalProvider,
  agentRunsTrendProvider,
  agentSpendByActorProvider,
  agentSpendByModelProvider,
  agentSpendTotalProvider,
  agentThreadsPagedTableProvider,
  agentTokensTotalProvider,
  agentToolCallsPagedTableProvider,
  agentToolStatsTableProvider,
  agentTopThreadsTableProvider,
  agentUsageTrendProvider,
} from './agent-governance-providers.js';
import { AgentTelescopeWatcher } from './agent-telescope.watcher.js';
import {
  ragChunksProvider,
  ragCollectionsTableProvider,
  ragLatencyProvider,
  ragRetrievalsProvider,
  ragRetrieverBreakdownProvider,
  ragScoresProvider,
  ragSlowestTableProvider,
  ragStoreBreakdownProvider,
  ragTrendProvider,
  ragZeroHitRateProvider,
} from './rag-data-providers.js';
import { RagTelescopeWatcher } from './rag-telescope.watcher.js';

/** The provider-name prefix this extension owns. A host contribution may not claim a name under it. */
const RESERVED_PROVIDER_PREFIX = 'agent.';

export interface AgentTelescopeExtensionOptions {
  /** Deep-link template for a `{threadId}` cell, e.g. `'/admin/threads/{threadId}'`. */
  threadHref?: string;
  /** Deep-link template for a `{runId}` cell. Defaults to the in-app trace waterfall. */
  runHref?: string;
  /**
   * HOST-contributed data providers, registered alongside the built-in ones.
   *
   * This exists because a panel on this dashboard **cannot** bind to a provider contributed by a
   * different extension, and the reason is structural rather than a policy we could relax: the UI
   * derives the request path from the dashboard id (`agent.overview` → `GET /ext/agent/data/:name`),
   * and the controller 404s when `providerOwner(name) !== ext` so the URL namespace cannot be
   * spoofed. A host that registers its own `TelescopeModule` extension therefore gets its own tab,
   * never a panel on this one. Passing the providers through here makes THIS extension their owner,
   * which is what makes a host section on this page resolve at all.
   *
   * Name them under your own prefix (`myapp.rag.collections`); anything starting with `agent.` is
   * refused at boot, because a collision there would surface as Telescope's generic "contributed by
   * both agent and agent" error, which names the same extension twice and says nothing useful.
   */
  providers?: DataProvider[];
  /**
   * HOST-contributed dashboard sections, appended after the built-in ones. Bind their panels to the
   * providers passed above (or to any built-in `agent.*` provider).
   *
   * Size each section's panel count to an exact multiple of its `cols`, for the same reason every
   * built-in section is: the renderer lays a section out as a fixed `grid-cols-N` grid with no
   * `colSpan`, so an orphan panel leaves a visible hole beside it. That is a layout convention, not
   * something validated here — a gap is cosmetic, and failing a host's boot over cosmetics would be
   * a worse trade than the gap.
   */
  sections?: DashboardSection[];
}

/**
 * The first-class Telescope extension for nestjs-agent: an "Agent" tab fed by three sources —
 * the `aviary:agent:*` diagnostics channel (live runs, tool calls) via the watcher, the
 * authoritative `AGENT_GOVERNANCE_QUERIES` read-model (historical spend/usage, run reliability,
 * tool activity, the approvals inbox) via the governance providers, and the `aviary:rag:retrieval`
 * channel (retrieval latency, chunk counts, score distribution, store/collection) via the RAG
 * watcher and providers. The extension `name`, entry-type ids, dashboard id, and every built-in
 * provider name share the `agent` prefix so the registry's global-uniqueness namespaces never
 * collide with sibling extensions.
 *
 * `threadHref` deep-links a table row's `threadId` cell out to the HOST's own thread viewer —
 * passed straight through to {@link agentDashboard}, mirroring `durableTelescopeExtension`'s
 * `runHref` option. A row's `runId` cell instead defaults to the IN-APP trace waterfall
 * (`#/traces/{runId}`, per wave-polish-CONTRACTS.md §A2) — no host wiring needed; `runHref`
 * overrides that default for a host that wants its own run viewer instead.
 *
 * Host wiring: the governance panels (Spend/Models/Actors/Reliability/Runs/Threads/Approvals/Tool
 * stats/Recent tool calls) resolve `AGENT_GOVERNANCE_QUERIES` from the host DI container at
 * request time (via `ctx.moduleRef`). The host must bind that token — from its store adapter
 * (e.g. `store-mikro-orm` / `store-drizzle` / `testing`) — in the same module that registers
 * `TelescopeModule.forRoot({ extensions: [agentTelescopeExtension()] })`. If the binding is
 * absent, those panels render an empty state; the live watcher-fed panels (Runs/Tokens stats and
 * the Tool-call status breakdown) keep working regardless. The RAG panels need no binding at all —
 * they read Telescope's own storage — but they stay empty until something emits retrieval telemetry
 * (`createRetrievalTool` does by default; `instrumentRetriever` for every other call path).
 */
export function agentTelescopeExtension(opts: AgentTelescopeExtensionOptions = {}) {
  const hostProviders = opts.providers ?? [];
  const reserved = hostProviders.filter((provider) =>
    provider.name.startsWith(RESERVED_PROVIDER_PREFIX),
  );
  if (reserved.length > 0) {
    throw new Error(
      `agentTelescopeExtension: host-contributed data providers may not use the reserved "${RESERVED_PROVIDER_PREFIX}" prefix — ` +
        `rename ${reserved.map((provider) => `"${provider.name}"`).join(', ')} to your own namespace.`,
    );
  }
  return defineTelescopeExtension({
    name: 'agent',
    watchers: () => [new AgentTelescopeWatcher(), new RagTelescopeWatcher()],
    entryTypes: () => [
      { id: 'agent', label: 'Agent', dot: 'bg-violet-400' },
      { id: 'agent-rag', label: 'RAG', dot: 'bg-emerald-400' },
    ],
    dashboards: () => [
      agentDashboard({
        ...(opts.threadHref !== undefined ? { threadHref: opts.threadHref } : {}),
        ...(opts.runHref !== undefined ? { runHref: opts.runHref } : {}),
        ...(opts.sections !== undefined ? { sections: opts.sections } : {}),
      }),
    ],
    dataProviders: () => [
      agentRunsProvider(),
      agentTokensProvider(),
      agentToolStatusProvider(),
      agentSpendTotalProvider(),
      agentTokensTotalProvider(),
      agentSpendByModelProvider(),
      agentModelSpendTableProvider(),
      agentUsageTrendProvider(),
      agentActorSpendTableProvider(),
      agentSpendByActorProvider(),
      agentTopThreadsTableProvider(),
      agentRunsTotalProvider(),
      agentRunsSuccessRateProvider(),
      agentRunsFailedProvider(),
      agentRunsRetriesProvider(),
      agentRunsDurationProvider(),
      agentRunsByAgentTableProvider(),
      agentRunErrorsProvider(),
      agentRunsTrendProvider(),
      agentRecentRunsTableProvider(),
      agentRecentToolCallsTableProvider(),
      agentRecentThreadsTableProvider(),
      agentRunsPagedTableProvider(),
      agentToolCallsPagedTableProvider(),
      agentThreadsPagedTableProvider(),
      agentPendingApprovalsCountProvider(),
      agentPendingApprovalsTableProvider(),
      agentToolStatsTableProvider(),
      ragRetrievalsProvider(),
      ragZeroHitRateProvider(),
      ragChunksProvider(),
      ragLatencyProvider(),
      ragScoresProvider(),
      ragTrendProvider(),
      ragStoreBreakdownProvider(),
      ragRetrieverBreakdownProvider(),
      ragCollectionsTableProvider(),
      ragSlowestTableProvider(),
      ...hostProviders,
    ],
  });
}
