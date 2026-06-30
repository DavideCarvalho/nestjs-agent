import type {
  MessageUsage,
  ModelMessage,
  ToolCallRequest,
  ToolDefinition,
} from '../types.js';
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
