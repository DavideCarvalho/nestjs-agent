import type {
  AgentStore,
  ModelProvider,
  Persona,
  PromptBuilder,
  QuotaStore,
  Retriever,
  RolesPolicy,
  SinkWriter,
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
  /** Inject-mode retriever (from `forRoot({ retrieval })`). Undefined → no prompt augmentation. */
  retriever?: Retriever;
  /** Passages inject-mode retrieval requests. Undefined → loop default (5). */
  retrievalTopK?: number;
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Wraps a parent run's sink writer for a sub-agent: `write` forwards (so the sub-agent's tokens and
 * pending action-tool frames reach the human's live stream), but `end` / `fail` are swallowed — the
 * top-level run owns the stream's lifecycle, so a finished/failed child must not close or error the
 * shared stream out from under the parent that is still running.
 */
export function childSinkWriter(writer: SinkWriter): SinkWriter {
  return {
    write: (chunk) => writer.write(chunk),
    end: async () => {},
    fail: async () => {},
  };
}
