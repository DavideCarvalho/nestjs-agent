import type {
  AgentStore,
  ModelProvider,
  Persona,
  PromptBuilder,
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
  /** Fallback accounting label; the provider's turn result overrides it when set. */
  modelId?: string;
  systemPrompt: string | PromptBuilder;
  maxSteps: number;
  personas: Map<string, Persona>;
  defaultPersona: string;
  /** Agent-level tool allow-list (intersected with the persona's). Undefined → all tools. */
  toolAllowList?: string[];
  /** Per-tool execution timeout in ms (from module options). Undefined → no timeout. */
  toolTimeoutMs?: number;
  /** How many follow-up suggestions to generate after the final turn. Undefined/0 → off. */
  followUpsCount?: number;
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
