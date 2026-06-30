import { defineTelescopeExtension } from '@dudousxd/nestjs-telescope';
import {
  agentRunsProvider,
  agentToolStatusProvider,
  agentToolsProvider,
  agentTokensProvider,
} from './agent-data-providers.js';
import { agentDashboard } from './agent-dashboard.js';
import { AgentTelescopeWatcher } from './agent-telescope.watcher.js';

/**
 * The first-class Telescope extension for nestjs-agent: an "Agent" tab fed by the
 * `aviary:agent:*` diagnostics channel. The extension `name`, entry-type id, dashboard id,
 * and every provider name share the `agent` prefix so the registry's global-uniqueness
 * namespaces never collide with sibling extensions.
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
    ],
  });
}
