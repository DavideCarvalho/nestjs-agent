import type {
  AgentStore,
  ModelProvider,
  Persona,
  QuotaStore,
  RolesPolicy,
  TokenStreamSink,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';

/** Everything `runAgentLoop` needs, minus the per-run `day` the runner stamps. */
export interface AgentDeps {
  model: ModelProvider;
  store: AgentStore;
  registry: ToolRegistry;
  rolesPolicy: RolesPolicy;
  quota?: QuotaStore;
  sink: TokenStreamSink;
  modelId: string;
  systemPrompt: string;
  maxSteps: number;
  personas: Map<string, Persona>;
  defaultPersona: string;
}

/** Internal bundle token shared between the inline runner, durable workflow, and service. */
export const AGENT_DEPS = Symbol.for('@dudousxd/nestjs-agent:deps');

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
