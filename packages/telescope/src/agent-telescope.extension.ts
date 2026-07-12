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

/**
 * The first-class Telescope extension for nestjs-agent: an "Agent" tab fed by two sources —
 * the `aviary:agent:*` diagnostics channel (live runs, tool calls) via the watcher, and the
 * authoritative `AGENT_GOVERNANCE_QUERIES` read-model (historical spend/usage, run reliability,
 * tool activity, the approvals inbox) via the governance providers. The extension `name`,
 * entry-type id, dashboard id, and every provider name share the `agent` prefix so the registry's
 * global-uniqueness namespaces never collide with sibling extensions.
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
 * the Tool-call status breakdown) keep working regardless.
 */
export function agentTelescopeExtension(opts: { threadHref?: string; runHref?: string } = {}) {
  return defineTelescopeExtension({
    name: 'agent',
    watchers: () => [new AgentTelescopeWatcher()],
    entryTypes: () => [{ id: 'agent', label: 'Agent', dot: 'bg-violet-400' }],
    dashboards: () => [agentDashboard(opts)],
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
    ],
  });
}
