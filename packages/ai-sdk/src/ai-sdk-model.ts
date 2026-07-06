import type {
  MessageUsage,
  ModelMessage,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  ToolCallRequest,
  ToolDefinition,
  ToolResult,
} from '@dudousxd/nestjs-agent-core';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import {
  type AssistantContent,
  type CallSettings,
  type FlexibleSchema,
  type JSONSchema7,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ProviderMetadata,
  type ModelMessage as SdkModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  type TypedToolCall,
  jsonSchema,
  streamText,
  tool,
} from 'ai';

/**
 * Pass-through settings forwarded to the AI SDK `streamText` call (headers, temperature,
 * `maxOutputTokens`, `providerOptions`, …). `model`, `system`, `messages`, `tools`, and
 * `abortSignal` are owned by the adapter and always win over anything set here.
 */
export type AiSdkModelOptions = CallSettings;

/**
 * Adapt a Vercel AI SDK v6 `LanguageModel` to the core `ModelProvider` SPI so a host app writes
 * zero provider code. Streams text deltas to `args.sink`, returns the assembled text, requested
 * tool calls, usage, and (when a gateway reports it) the real USD cost. It never executes tools —
 * tools are handed to the SDK WITHOUT an `execute` fn, so the SDK returns tool-calls for the agent
 * loop to run as its own (replay-safe) steps.
 */
export function aiSdkModel(model: LanguageModel, opts?: AiSdkModelOptions): ModelProvider {
  return {
    async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
      const result = streamText({
        ...opts,
        model,
        system: args.system,
        messages: mapMessages(args.messages),
        tools: mapTools(args.tools),
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      });

      // Encode deltas to bytes for the live token sink, exactly as the reference fake provider does.
      const encoder = new TextEncoder();
      let text = '';
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          text += part.text;
          await args.sink.write(encoder.encode(part.text));
        }
      }

      // The promise accessors resolve once `fullStream` is fully consumed above.
      const [toolCalls, usage, response, providerMetadata] = await Promise.all([
        result.toolCalls,
        result.usage,
        result.response,
        result.providerMetadata,
      ]);

      const modelId = response.modelId;
      const costUsd = extractCostUsd(providerMetadata);

      return {
        text,
        toolCalls: toolCalls.map(mapToolCall),
        usage: mapUsage(usage),
        ...(typeof modelId === 'string' && modelId.length > 0 ? { modelId } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}

/**
 * Map core `ModelMessage[]` → SDK messages. Tool calls ride on the assistant message as
 * `tool-call` content parts; tool results become a following `tool` message. A message can
 * therefore expand into two SDK messages, so we build the list imperatively.
 */
function mapMessages(messages: ModelMessage[]): SdkModelMessage[] {
  const out: SdkModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length > 0) {
      const content: Array<TextPart | ToolCallPart> = [];
      if (message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        });
      }
      out.push({ role: 'assistant', content: assistantContent(content) });
    } else {
      out.push({ role: 'assistant', content: message.content });
    }

    const toolResults = message.toolResults ?? [];
    if (toolResults.length > 0) {
      out.push({
        role: 'tool',
        content: toolResults.map(
          (result): ToolResultPart => ({
            type: 'tool-result',
            toolCallId: result.id,
            toolName: result.name,
            output: toModelOutput(result),
          }),
        ),
      });
    }
  }
  return out;
}

/** `Array<TextPart | ToolCallPart>` is a valid `AssistantContent`; name the widening explicitly. */
function assistantContent(parts: Array<TextPart | ToolCallPart>): AssistantContent {
  return parts;
}

/**
 * NOTE: core tool `output` is `unknown`, but the SDK's structured `json` output demands a
 * `JSONValue`. Rather than an unsafe cast we serialise every result to text — the model reads
 * tool output as text regardless, and the loop already validated the tool INPUT via the schema.
 */
function toModelOutput(result: ToolResult): { type: 'text'; value: string } {
  if (result.error !== undefined) {
    return { type: 'text', value: result.error };
  }
  const { output } = result;
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  return { type: 'text', value: JSON.stringify(output ?? null) };
}

/**
 * Map core `ToolDefinition[]` → an SDK `ToolSet`. Each tool is built WITHOUT an `execute` fn so the
 * SDK surfaces the tool-call for the agent loop to run, instead of executing it inline.
 */
function mapTools(tools: ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: toSdkInputSchema(definition.inputSchema),
    });
  }
  return set;
}

/**
 * Convert a core `StandardSchemaV1` into the schema the SDK feeds the model as tool parameters.
 * The SDK accepts a Standard Schema directly ONLY when it also implements the Standard JSON Schema
 * extension (`~standard.jsonschema`) — which Zod/Valibot/ArkType provide — because the SDK calls
 * that converter to derive the JSON schema. When the schema doesn't expose the converter we can't
 * derive a precise JSON schema, so we fall back to a permissive object schema; the agent loop still
 * validates the tool input against the real schema via `~standard.validate` before running it.
 */
function toSdkInputSchema(schema: StandardSchemaV1): FlexibleSchema<unknown> {
  if (hasStandardJsonSchema(schema)) {
    return schema;
  }
  return jsonSchema(permissiveObjectSchema());
}

function permissiveObjectSchema(): JSONSchema7 {
  return { type: 'object', properties: {}, additionalProperties: true };
}

/** True when the schema carries the Standard JSON Schema converter the SDK needs to build params. */
function hasStandardJsonSchema(
  schema: StandardSchemaV1,
): schema is StandardSchemaV1 & StandardJSONSchemaV1 {
  const standard = schema['~standard'];
  if (!('jsonschema' in standard)) {
    return false;
  }
  const converter = standard.jsonschema;
  return (
    typeof converter === 'object' &&
    converter !== null &&
    'input' in converter &&
    typeof converter.input === 'function'
  );
}

function mapToolCall(call: TypedToolCall<ToolSet>): ToolCallRequest {
  return { id: call.toolCallId, name: call.toolName, input: call.input };
}

/**
 * Map SDK usage → core `MessageUsage`. Cache/reasoning breakdowns are optional and only added when
 * the provider reports them (conditional spread, never an `undefined` assignment). The `*Details`
 * objects prefer the current field names, falling back to the SDK's deprecated flat aliases.
 */
function mapUsage(usage: LanguageModelUsage): MessageUsage {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * A gateway reports the ACTUAL spend for the turn; a direct provider (Anthropic/OpenAI/Bedrock)
 * doesn't, leaving this undefined so the governance read-model estimates from tokens. We read the
 * Vercel AI Gateway shape (`gateway.cost`) first, then OpenRouter (`openrouter.total_cost`, also
 * nested under `openrouter.usage.total_cost`).
 */
function extractCostUsd(metadata: ProviderMetadata | undefined): number | undefined {
  if (!metadata) {
    return undefined;
  }
  const gateway = metadata.gateway;
  const gatewayCost = gateway ? toFiniteNumber(gateway.cost) : undefined;
  if (gatewayCost !== undefined) {
    return gatewayCost;
  }
  const openrouter = metadata.openrouter;
  if (openrouter) {
    const direct = toFiniteNumber(openrouter.total_cost);
    if (direct !== undefined) {
      return direct;
    }
    const usage = asJsonObject(openrouter.usage);
    if (usage) {
      const nested = toFiniteNumber(usage.total_cost);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function toFiniteNumber(value: JSONValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asJsonObject(
  value: JSONValue | undefined,
): { [key: string]: JSONValue | undefined } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
