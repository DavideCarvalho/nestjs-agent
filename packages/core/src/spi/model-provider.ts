import type { MessageUsage, ModelMessage, ToolCallRequest, ToolDefinition } from '../types.js';
import type { SinkWriter } from './token-stream-sink.js';

export interface ModelTurnArgs {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /** The model writes streamed text deltas here as it generates them. */
  sink: SinkWriter;
  abortSignal?: AbortSignal;
}

/** The outcome of ONE assistant turn. The loop — not the model — drives tool execution. */
export interface ModelTurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
  usage: MessageUsage;
  /**
   * The model actually used this turn (e.g. `anthropic.claude-...`), recorded with usage for
   * cost accounting. When set it wins over the module's configured `modelId`, so the accounting
   * label can't silently drift from the runtime. Omit if the provider can't report one.
   */
  modelId?: string;
  /**
   * The ACTUAL USD cost of this turn, when the provider knows it — a gateway (Vercel AI Gateway
   * `providerMetadata.gateway.cost`, OpenRouter `total_cost`) reports real spend; a direct provider
   * (Anthropic/OpenAI/Bedrock) reports only tokens and leaves this undefined. When set, the
   * governance read-model uses it verbatim; otherwise it estimates from tokens × the pricing table.
   */
  costUsd?: number;
}

/**
 * Thin wrapper over the actual LLM. The concrete impl (e.g. Vercel AI SDK `streamText`
 * over Bedrock/Anthropic) lives in the host app or an adapter; core stays provider-free.
 *
 * Contract: `runTurn` performs exactly one model turn, streaming deltas to `args.sink`,
 * and returns the assembled text + requested tool calls + usage. It MUST NOT execute
 * tools — the agent loop runs each as a (durable) step for replay-safety.
 */
export interface ModelProvider {
  runTurn(args: ModelTurnArgs): Promise<ModelTurnResult>;
}
