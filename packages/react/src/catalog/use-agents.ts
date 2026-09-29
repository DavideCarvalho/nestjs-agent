import type { AgentCatalogEntry } from '@dudousxd/nestjs-agent-core';
import { useMemo } from 'react';
import { type AgentBackend, requireBackendMethod } from '../backend.js';
import { useResource } from './use-resource.js';

export interface UseAgentsOptions {
  /** `useAgentChat(...).backend`, or your own. Must implement `listAgents`. */
  backend: AgentBackend;
  /** `false` holds the request. Default `true`. */
  enabled?: boolean;
}

export interface AgentsState {
  /** `[]` until loaded. */
  agents: AgentCatalogEntry[];
  /** The agent a turn runs as when none is named. */
  defaultAgent: string | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * The registered agents (`GET <base>/agents`) — the data behind an agent picker. Send the pick as
 * `useAgentChat({ agent })`, or pin it on a thread with `PATCH <base>/threads/:id { defaultAgent }`.
 */
export function useAgents(options: UseAgentsOptions): AgentsState {
  const { backend, enabled = true } = options;
  const { data, isLoading, error, refresh } = useResource<AgentCatalogEntry[]>(
    () => requireBackendMethod(backend, 'listAgents')(),
    '',
    enabled,
  );
  return useMemo(() => {
    const agents = data ?? [];
    return {
      agents,
      defaultAgent: agents.find((agent) => agent.isDefault === true)?.name ?? null,
      isLoading,
      error,
      refresh,
    };
  }, [data, isLoading, error, refresh]);
}
