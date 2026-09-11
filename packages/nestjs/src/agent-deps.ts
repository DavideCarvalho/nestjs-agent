import type {
  AgentIntake,
  AgentPricingStore,
  AgentStore,
  HistoryPolicy,
  InputProcessor,
  ModelProvider,
  OutputProcessor,
  PromptBuilder,
  PromptContributor,
  QuotaStore,
  Retriever,
  RolesPolicy,
  SinkWriter,
  TokenStreamSink,
  ToolRegistry,
  ToolTransientRetrySetting,
} from '@dudousxd/nestjs-agent-core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

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
  /** App-wide `@SystemPromptContributor()` sections appended after the agent's base prompt. */
  promptContributors: PromptContributor[];
  maxSteps: number;
  /** Agent-level tool allow-list. Undefined → all tools (after role filtering). */
  toolAllowList?: string[];
  /** Per-tool execution timeout in ms (from module options). Undefined → no timeout. */
  toolTimeoutMs?: number;
  /**
   * Transient-tool-error retry policy (from module options). Undefined → default ON
   * (`{ attempts: 2, backoffMs: 150 }` with the default classifier); `false` → disabled.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /** How many follow-up suggestions to generate after the final turn. Undefined/0 → off. */
  followUpsCount?: number;
  /** Inject-mode retriever (from `forRoot({ retrieval })`). Undefined → no prompt augmentation. */
  retriever?: Retriever;
  /** Passages inject-mode retrieval requests. Undefined → loop default (5). */
  retrievalTopK?: number;
  /** Bound `AGENT_PRICING_STORE`, when a module (e.g. a store's) provides one. Undefined → no pricing. */
  pricingStore?: AgentPricingStore;
  /** The agent's history ceiling, resolved from `@Agent({ history })` / module options. Undefined → unbounded. */
  historyPolicy?: HistoryPolicy;
  /** Module-wide prompt rewriters, applied before every model call. Empty → none. */
  inputProcessors: InputProcessor[];
  /** Module-wide answer gates. NON-EMPTY MEANS THE TURN'S MODEL OUTPUT IS BUFFERED, not streamed. */
  outputProcessors: OutputProcessor[];
  /** The agent's `@Agent({ outputSchema })`, resolved from DI — never over the wire. Undefined → free text. */
  outputSchema?: StandardSchemaV1;
  /** Extra model calls allowed to repair an answer that failed `outputSchema`. Undefined → 1. */
  outputRepairAttempts?: number;
  /** The agent's `@Agent({ intake })` question set, asked before the turn starts. Undefined → none. */
  intake?: AgentIntake;
  /** Whether the model may call the built-in `ask` tool this turn. Undefined/false → it never sees it. */
  ask?: boolean;
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
