import { defineTelescopeExtension } from '@dudousxd/nestjs-telescope';
import { agentDashboard } from './agent-dashboard.js';
import {
  agentRunsProvider,
  agentTokensProvider,
  agentToolStatusProvider,
  agentToolsProvider,
} from './agent-data-providers.js';
import {
  agentActorSpendTableProvider,
  agentModelSpendTableProvider,
  agentSpendByActorProvider,
  agentSpendByModelProvider,
  agentSpendTotalProvider,
  agentTokensTotalProvider,
  agentUsageTrendProvider,
} from './agent-governance-providers.js';
import { AgentTelescopeWatcher } from './agent-telescope.watcher.js';

/**
 * The first-class Telescope extension for nestjs-agent: an "Agent" tab fed by two sources —
 * the `aviary:agent:*` diagnostics channel (live runs, tool calls) via the watcher, and the
 * authoritative `AGENT_GOVERNANCE_QUERIES` read-model (historical spend/usage) via the governance
 * providers. The extension `name`, entry-type id, dashboard id, and every provider name share the
 * `agent` prefix so the registry's global-uniqueness namespaces never collide with sibling extensions.
 *
 * Host wiring: the governance (Spend/Models/Actors) panels resolve `AGENT_GOVERNANCE_QUERIES` from
 * the host DI container at request time (via `ctx.moduleRef`). The host must bind that token — from
 * its store adapter (e.g. `store-mikro-orm` / `store-drizzle` / `testing`) — in the same module that
 * registers `TelescopeModule.forRoot({ extensions: [agentTelescopeExtension()] })`. If the binding is
 * absent, those panels render an empty state; the live watcher-fed panels keep working regardless.
 */
export function agentTelescopeExtension() {
  return defineTelescopeExtension({
    name: 'agent',
    watchers: () => [new AgentTelescopeWatcher()],
    entryTypes: () => [{ id: 'agent', label: 'Agent', dot: 'bg-violet-400' }],
    dashboards: () => [agentDashboard()],
    dataProviders: () => [
      agentRunsProvider(),
      agentTokensProvider(),
      agentToolsProvider(),
      agentToolStatusProvider(),
      agentSpendTotalProvider(),
      agentTokensTotalProvider(),
      agentSpendByModelProvider(),
      agentModelSpendTableProvider(),
      agentUsageTrendProvider(),
      agentActorSpendTableProvider(),
      agentSpendByActorProvider(),
    ],
  });
}
