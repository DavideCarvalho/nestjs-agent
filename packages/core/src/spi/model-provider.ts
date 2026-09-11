import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { MessageUsage, ModelMessage, ToolCallRequest, ToolDefinition } from '../types.js';
import type { SinkWriter } from './token-stream-sink.js';

export interface ModelTurnArgs {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /** The model writes streamed text deltas here as it generates them. */
  sink: SinkWriter;
  abortSignal?: AbortSignal;
  /**
   * Constrain this turn's reply to a schema (a provider's JSON/response-format mode). Set only on
   * the loop's structured-output formatting pass, which always sends `tools: []` — most providers
   * refuse a response format and a tool set in the same request, and the ones that accept both stop
   * calling tools. A provider that cannot constrain generation may ignore this: the loop validates
   * the reply against the same schema either way, so ignoring it costs reliability, not safety.
   */
  outputSchema?: StandardSchemaV1;
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
  /**
   * The reply already parsed, for a provider that constrained generation against
   * {@link ModelTurnArgs.outputSchema} and therefore has the value in hand. A fast path only — the
   * loop validates it against the schema regardless, so omitting it (and leaving the loop to read
   * the JSON out of `text`) is always correct.
   */
  object?: unknown;
}

/**
 * A model turn whose live frames were HELD instead of streamed, because an output processor has to
 * see the whole answer before anything downstream does. Produced by whatever ran the model call —
 * the loop itself, or the dispatched-step handler when the envelope asked for it — and released to
 * the real sink by the loop once the gate has passed.
 */
export interface BufferedModelTurnResult extends ModelTurnResult {
  /** The NDJSON stream lines the call produced, in write order. */
  bufferedFrames?: string[];
  /**
   * The transformed PREFIX an incremental gate already wrote to the run's sink while the call was
   * streaming. Its presence — not the chain configured on the process that reads it back — is what
   * tells the gate step which release this turn still owes, so a run that resumes under a
   * re-declared chain cannot flush the same text twice. Empty string when an incremental gate ran
   * and released nothing; absent when none ran.
   */
  releasedText?: string;
  /**
   * The refusal an incremental gate reached from a prefix, carried on the RESULT rather than thrown
   * from the call. The loop raises it only after the turn's `persist:usage` and `quota:bump`
   * checkpoints — those tokens were genuinely spent, and a gate that hid its own cost would let a
   * mis-tuned chain burn a budget invisibly.
   */
  gateRejection?: { processor: string; reason: string };
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
