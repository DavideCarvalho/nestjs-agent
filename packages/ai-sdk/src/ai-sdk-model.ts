import {
  type DescribedModel,
  type MessageAttachment,
  type MessageUsage,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogView,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolResult,
  encodeStreamEvent,
  schemaExtensionOf,
  staticModelCatalog,
} from '@dudousxd/nestjs-agent-core';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import {
  type AssistantContent,
  type CallSettings,
  type Experimental_DownloadFunction,
  type FilePart,
  type FlexibleSchema,
  type ImagePart,
  type JSONSchema7,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  Output,
  type ProviderMetadata,
  type ModelMessage as SdkModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  type TypedToolCall,
  asSchema,
  jsonSchema,
  streamText,
  tool,
} from 'ai';
import type { ZodTypeAny } from 'zod';

/**
 * Pass-through settings forwarded to the AI SDK `streamText` call (headers, temperature,
 * `maxOutputTokens`, `providerOptions`, …). `model`, `instructions`, `messages`, `tools`, and
 * `abortSignal` are owned by the adapter and always win over anything set here.
 */
export type AiSdkModelOptions = CallSettings & {
  /**
   * Override the AI SDK's file/attachment downloader (`experimental_download` on `streamText`).
   * The SDK's DEFAULT downloader refuses localhost/private hostnames (SSRF guard), which breaks
   * attachment parts whose staging presigns against a local object store (e.g. MinIO in dev) —
   * the model call dies with `AI_DownloadError: URL with hostname localhost is not allowed`.
   * Attachment URLs come from the host's own staging SPI — never from user input — so relaxing
   * the guard with a plain fetch is the host's legitimate call.
   */
  experimental_download?: Experimental_DownloadFunction;
  /**
   * Provider-specific request options (`streamText`'s `providerOptions`). For an OpenRouter model the
   * adapter adds `openrouter.usage = { include: true }` (usage accounting, which is what makes
   * OpenRouter report each call's cost) unless you set `openrouter.usage` yourself.
   */
  providerOptions?: StreamProviderOptions;
};

/** `streamText`'s `providerOptions`, taken off its own signature. */
type StreamProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

/** The id a `LanguageModel` answers to: the gateway string itself, or the instance's `modelId`. */
function idOf(model: LanguageModel): string | undefined {
  if (typeof model === 'string') return model;
  const id = (model as { modelId?: unknown }).modelId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Adapt a Vercel AI SDK v7 `LanguageModel` to the core `ModelProvider` SPI so a host app writes
 * zero provider code. Streams text deltas to `args.sink`, returns the assembled text, requested
 * tool calls, usage, and (when a gateway reports it) the real USD cost. It never executes tools —
 * tools are handed to the SDK WITHOUT an `execute` fn, so the SDK returns tool-calls for the agent
 * loop to run as its own (replay-safe) steps.
 */
/**
 * The provider family of an AI SDK model, as models.dev names it: `openrouter.chat` → `openrouter`,
 * `anthropic.messages` → `anthropic`. A bare string id is routed by the Vercel AI Gateway (`vercel`).
 */
function providerOf(model: LanguageModel): string | undefined {
  if (typeof model === 'string') return 'vercel';
  const provider = (model as { provider?: unknown }).provider;
  if (typeof provider !== 'string' || provider.length === 0) return undefined;
  const family = provider.split('.')[0] ?? provider;
  return family === 'gateway' ? 'vercel' : family;
}

/** OpenRouter (`@openrouter/ai-sdk-provider`): reports the real, routed cost per call. */
function isOpenRouter(model: LanguageModel): boolean {
  return providerOf(model) === 'openrouter';
}

/**
 * Whether a model's provider reports the call's real USD cost in its metadata — the Vercel AI
 * Gateway (`providerMetadata.gateway.cost`) and OpenRouter (`providerMetadata.openrouter.usage.cost`).
 */
function reportsCost(model: LanguageModel): boolean {
  const provider = providerOf(model);
  return provider === 'vercel' || provider === 'openrouter';
}

function describeModel(model: LanguageModel, id = idOf(model)): DescribedModel[] {
  if (id === undefined) return [];
  const provider = providerOf(model);
  return [
    {
      modelId: id,
      ...(provider !== undefined ? { provider } : {}),
      reportsCost: reportsCost(model),
    },
  ];
}

export function aiSdkModel(model: LanguageModel, opts?: AiSdkModelOptions): ModelProvider {
  const own = idOf(model);
  return {
    describeModels: () => describeModel(model, own),
    runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
      // One model, so a pick naming another cannot be honoured — and running this one instead
      // would answer on a model nobody chose. `aiSdkModels` is the provider for a picker.
      if (args.model !== undefined && args.model !== own) {
        throw new Error(
          `aiSdkModel: this turn picked model "${args.model}", but the provider serves only ` +
            `"${own ?? 'its one model'}". Offer several with aiSdkModels({ … }).`,
        );
      }
      return runTurnOn(model, opts ?? {}, args);
    },
  };
}

/** A model {@link aiSdkModels} offers, with what a picker shows for it. */
export interface AiSdkModelEntry {
  model: LanguageModel;
  /** Default: the id. */
  label?: string;
  description?: string;
  /** Chips — `'fast'`, `'reasoning'`, `'vision'`, … */
  badges?: string[];
  contextWindow?: number;
  /** The provider group it is listed under. Default: the id's prefix before `/`, else the model's provider. */
  provider?: string;
}

export interface AiSdkModelsOptions extends AiSdkModelOptions {
  /** The model a turn runs on when nobody picked one. Default: the first entry. */
  default?: string;
  /** Group id → label, for the picker. Default: the group id, capitalized. */
  providerLabels?: Record<string, string>;
}

/** A {@link ModelProvider} over several models, carrying the catalog a picker lists them from. */
export interface AiSdkModelsProvider extends ModelProvider {
  catalog: ModelCatalog;
}

function groupOf(id: string, entry: AiSdkModelEntry): string {
  if (entry.provider !== undefined) return entry.provider;
  const slash = id.indexOf('/');
  if (slash > 0) return id.slice(0, slash);
  const provider =
    typeof entry.model === 'string' ? undefined : (entry.model as { provider?: unknown }).provider;
  return typeof provider === 'string' ? (provider.split('.')[0] ?? provider) : 'models';
}

/**
 * Several AI SDK models behind one provider — the model picker's server half, in one place. The
 * keys are what a client picks (and what the catalog lists); `AgentModule` uses the provider's
 * `catalog` when `models` is omitted, so this is the whole setup:
 *
 * ```ts
 * AgentModule.forRoot({
 *   model: aiSdkModels(
 *     {
 *       fast: { model: openai('gpt-5-mini'), label: 'Fast', badges: ['fast'] },
 *       smart: anthropic('claude-sonnet-4-5'),
 *     },
 *     { default: 'fast' },
 *   ),
 * })
 * ```
 *
 * A turn with no pick runs on `default`; a pick the map does not hold fails the turn (the server
 * already refuses one its catalog does not list, so this only guards a hand-rolled catalog).
 */
export function aiSdkModels(
  models: Record<string, LanguageModel | AiSdkModelEntry>,
  options: AiSdkModelsOptions = {},
): AiSdkModelsProvider {
  const { default: defaultId, providerLabels, ...settings } = options;
  const entries = Object.entries(models).map(([id, value]) => {
    const entry: AiSdkModelEntry =
      typeof value === 'object' && value !== null && 'model' in value
        ? (value as AiSdkModelEntry)
        : { model: value as LanguageModel };
    return [id, entry] as const;
  });
  if (entries.length === 0) throw new Error('aiSdkModels: offer at least one model');
  const byId = new Map(entries);
  const fallback = defaultId ?? entries[0]?.[0];
  if (fallback === undefined || !byId.has(fallback)) {
    throw new Error(`aiSdkModels: default "${defaultId}" is not one of the offered models`);
  }
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const [id, entry] of entries) {
    const group = groupOf(id, entry);
    const list = groups.get(group) ?? [];
    list.push({
      id,
      label: entry.label ?? id,
      available: true,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.badges !== undefined ? { badges: entry.badges } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    });
    groups.set(group, list);
  }
  const view: ModelCatalogView = {
    default: fallback,
    providers: [...groups].map(([id, list]) => ({
      id,
      label: providerLabels?.[id] ?? id.charAt(0).toUpperCase() + id.slice(1),
      models: list,
    })),
  };
  return {
    catalog: staticModelCatalog(view),
    describeModels: () => entries.flatMap(([, entry]) => describeModel(entry.model)),
    runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
      const id = args.model ?? fallback;
      const entry = byId.get(id);
      if (entry === undefined) {
        throw new Error(
          `aiSdkModels: this turn picked model "${id}", which is not offered (` +
            `${[...byId.keys()].join(', ')}).`,
        );
      }
      return runTurnOn(entry.model, settings, args);
    },
  };
}

/** One model turn on `model` — the shared body of {@link aiSdkModel} and {@link aiSdkModels}. */
async function runTurnOn(
  model: LanguageModel,
  settings: AiSdkModelOptions,
  args: ModelTurnArgs,
): Promise<ModelTurnResult> {
  const result = streamText({
    ...settings,
    ...withOpenRouterUsageAccounting(model, settings.providerOptions),
    model,
    instructions: args.system,
    messages: mapMessages(args.messages),
    tools: mapTools(args.tools),
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    // `Output.object` asks the provider for its JSON/response-format mode. The agent loop only
    // ever sets `outputSchema` on a call that carries no tools, which is what keeps this off the
    // collision most providers have between a response format and a tool set.
    ...(args.outputSchema
      ? { output: Output.object({ schema: toSdkInputSchema(args.outputSchema) }) }
      : {}),
  });

  // Translate the model's streamed parts into the neutral AgentStreamEvent vocabulary and write
  // them to the sink, so the client reconstructs text, reasoning, and live tool-call cards (the
  // input streaming in) — not just text. Tool RESULTS are emitted by the agent loop after it runs
  // the tool; step boundaries are owned by the loop too (a step spans the model call + its tool
  // execution). `text` is still accumulated for the persisted assistant message.
  let text = '';
  for await (const part of result.stream) {
    switch (part.type) {
      case 'text-delta':
        text += part.text;
        await args.sink.write(encodeStreamEvent({ kind: 'text', text: part.text }));
        break;
      case 'reasoning-delta':
        await args.sink.write(encodeStreamEvent({ kind: 'reasoning', text: part.text }));
        break;
      case 'tool-input-start':
        await args.sink.write(
          encodeStreamEvent({
            kind: 'tool-input-start',
            id: part.id,
            name: part.toolName,
            toolKind: toolKindFor(part.toolName, args.tools),
          }),
        );
        break;
      case 'tool-input-delta':
        await args.sink.write(
          encodeStreamEvent({ kind: 'tool-input-delta', id: part.id, delta: part.delta }),
        );
        break;
      case 'tool-call':
        await args.sink.write(
          encodeStreamEvent({
            kind: 'tool-input-available',
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
            toolKind: toolKindFor(part.toolName, args.tools),
          }),
        );
        break;
      case 'error':
        // The provider's own failure. Thrown as it is: left alone, the stream ends empty and the
        // accessors below reject with the SDK's "No output generated. Check the stream for errors."
        // — which names no cause, and is all anyone would ever read.
        throw part.error instanceof Error
          ? part.error
          : new Error(typeof part.error === 'string' ? part.error : JSON.stringify(part.error));
      default:
        break;
    }
  }

  // The promise accessors resolve once the stream is fully consumed above. `modelId` and the
  // reported cost live on the final step (the top-level aliases are deprecated in AI SDK v7).
  const [toolCalls, usage, finalStep] = await Promise.all([
    result.toolCalls,
    result.usage,
    result.finalStep,
  ]);

  const modelId = finalStep.response.modelId;
  const costUsd = extractCostUsd(finalStep.providerMetadata);
  if (costUsd === undefined && isOpenRouter(model)) {
    warnOpenRouterCostMissing(idOf(model) ?? finalStep.response.modelId ?? 'unknown');
  }
  const object = args.outputSchema ? await parsedOutput(result.output) : undefined;

  return {
    text,
    toolCalls: toolCalls.map(mapToolCall),
    usage: mapUsage(usage),
    ...(typeof modelId === 'string' && modelId.length > 0 ? { modelId } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(object !== undefined ? { object } : {}),
  };
}

/**
 * The SDK's own parse of a constrained reply, or `undefined` when it refused to produce one (its
 * `NoObjectGeneratedError`). A refusal is deliberately NOT rethrown: `object` is only ever a fast
 * path past the agent loop's own validation, and the loop turns an unparseable reply into a
 * `StructuredOutputError` that carries the offending text and can be repaired — strictly more than
 * a throw from here would leave it with.
 */
async function parsedOutput(output: PromiseLike<unknown>): Promise<unknown> {
  try {
    return await output;
  } catch {
    return undefined;
  }
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
      const attachments = message.attachments ?? [];
      out.push(
        attachments.length === 0
          ? { role: 'user', content: message.content }
          : { role: 'user', content: userContentWithAttachments(message.content, attachments) },
      );
      continue;
    }

    const toolCalls = message.toolCalls ?? [];
    const toolResults = message.toolResults ?? [];
    // Anthropic and Bedrock refuse a whole request carrying an assistant message with empty content
    // or a whitespace-only text block. Blank text is therefore never sent as a part, and an assistant
    // message with nothing else on it is left out: it says nothing the model needs.
    const hasText = message.content.trim().length > 0;
    if (!hasText && toolCalls.length === 0 && toolResults.length === 0) {
      continue;
    }
    if (toolCalls.length > 0) {
      const content: Array<TextPart | ToolCallPart> = [];
      if (hasText) {
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
    } else if (hasText) {
      out.push({ role: 'assistant', content: message.content });
    }

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
 * Build a multimodal user content array: the text (when non-empty) followed by one part per
 * attachment — `image/*` → an image part, everything else → a file part (Bedrock Claude reads a PDF
 * this way). The attachment's `url` is passed straight through as the part's source; making it
 * reachable by the provider is the consumer's concern, not the adapter's.
 */
function userContentWithAttachments(
  text: string,
  attachments: MessageAttachment[],
): Array<TextPart | ImagePart | FilePart> {
  const parts: Array<TextPart | ImagePart | FilePart> = [];
  if (text.length > 0) {
    parts.push({ type: 'text', text });
  }
  for (const attachment of attachments) {
    parts.push(
      attachment.contentType.startsWith('image/')
        ? { type: 'image', image: new URL(attachment.url), mediaType: attachment.contentType }
        : {
            type: 'file',
            data: new URL(attachment.url),
            mediaType: attachment.contentType,
            filename: attachment.name,
          },
    );
  }
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
 * The SDK's own `asSchema` derives a precise JSON schema from exactly two kinds of Standard Schema,
 * so we hand those straight through and let it do the conversion:
 *
 *  - **Zod** (`~standard.vendor === 'zod'`) — the SDK runs zod-to-json-schema natively. Zod 3 does
 *    NOT expose the Standard JSON Schema extension, so this vendor tag is the only way to recognise
 *    it, and it's the common case (`@AiTool({ input: z.object(...) })`).
 *  - **Standard JSON Schema** (`~standard.jsonSchema`) — Valibot, ArkType, and Zod 4 implement the
 *    extension; the SDK calls its `input()` converter to derive the schema.
 *
 * Anything else is a bare Standard Schema the SDK can't introspect (its `asSchema` throws on one), so
 * we degrade to a permissive object schema — the model loses the parameter shapes, but the agent loop
 * still validates the tool input against the real schema via `~standard.validate` before running it.
 */
function toSdkInputSchema(schema: StandardSchemaV1): FlexibleSchema<unknown> {
  // A schema that is another schema plus a few properties (`withConfirmFields`): convert the inner
  // one the way it converts best — a Zod 3 schema only the SDK can describe — and add them.
  const extension = schemaExtensionOf(schema);
  if (extension !== undefined) {
    const base = asSchema(toSdkInputSchema(extension.base));
    return jsonSchema(async () => {
      const described = (await base.jsonSchema) as JSONSchema7;
      const properties = typeof described.properties === 'object' ? described.properties : {};
      return {
        ...described,
        type: 'object',
        properties: { ...properties, ...(extension.properties as JSONSchema7['properties']) },
      };
    });
  }
  if (isZodSchema(schema) || hasStandardJsonSchema(schema)) {
    return schema;
  }
  return jsonSchema({ type: 'object', properties: {}, additionalProperties: true });
}

/**
 * True for a Zod schema. Zod tags its Standard Schema props with `vendor: 'zod'`, and its own type
 * declares `~standard`, so this narrows to `ZodTypeAny` — a member of the SDK's `FlexibleSchema` —
 * without a cast, letting the SDK convert it natively.
 */
function isZodSchema(schema: StandardSchemaV1): schema is ZodTypeAny {
  return schema['~standard'].vendor === 'zod';
}

/** True when the schema carries the Standard JSON Schema converter (`~standard.jsonSchema.input`). */
function hasStandardJsonSchema(
  schema: StandardSchemaV1,
): schema is StandardSchemaV1 & StandardJSONSchemaV1 {
  const standard = schema['~standard'];
  if (!('jsonSchema' in standard)) {
    return false;
  }
  const converter = standard.jsonSchema;
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
 * The wire `toolKind` for a tool-input stream frame, looked up from this turn's `ToolDefinition`s
 * (which the registry already stamped with the tool's declared kind). Collapses `'agent'` (a
 * delegation tool, which auto-executes) into `'read'` — the wire vocabulary is `'read' | 'action'`
 * only, matching what a client actually needs to decide (does this need my approval or not).
 */
function toolKindFor(toolName: string, tools: ToolDefinition[]): 'read' | 'action' {
  const kind = tools.find((definition) => definition.name === toolName)?.kind;
  return kind === 'action' ? 'action' : 'read';
}

/**
 * Map SDK usage → core `MessageUsage`. Cache/reasoning breakdowns are optional and only added when
 * the provider reports them (conditional spread, never an `undefined` assignment). AI SDK v7 carries
 * them on the `*Details` objects; the deprecated flat aliases (`cachedInputTokens`, `reasoningTokens`)
 * were removed.
 */
function mapUsage(usage: LanguageModelUsage): MessageUsage {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * OpenRouter only reports cost in the response when usage accounting is asked for
 * (`usage: { include: true }`). The OpenRouter provider forwards `providerOptions.openrouter` into the
 * request body, so the adapter asks on every OpenRouter call — unless the app set its own `usage`,
 * which wins. Any other model gets the options untouched.
 */
function withOpenRouterUsageAccounting(
  model: LanguageModel,
  providerOptions: StreamProviderOptions | undefined,
): { providerOptions?: StreamProviderOptions } {
  if (!isOpenRouter(model)) {
    return providerOptions !== undefined ? { providerOptions } : {};
  }
  const own = providerOptions?.openrouter ?? {};
  return {
    providerOptions: { ...providerOptions, openrouter: { usage: { include: true }, ...own } },
  };
}

const openRouterCostWarned = new Set<string>();

/** Said once per model per process: an OpenRouter call came back without `usage.cost`. */
function warnOpenRouterCostMissing(modelId: string): void {
  if (openRouterCostWarned.has(modelId)) return;
  openRouterCostWarned.add(modelId);
  console.warn(
    `[nestjs-agent] OpenRouter model "${modelId}" returned no cost (\`providerMetadata.openrouter.usage.cost\`). Cost falls back to the pricing table, which may have no row for it. Use \`@openrouter/ai-sdk-provider\` >= 1 (\`createOpenRouter(...).chat(id)\`); do not set \`usage: { include: false }\`.`,
  );
}

/** Test seam: forget which models already warned. */
export function resetOpenRouterCostWarnings(): void {
  openRouterCostWarned.clear();
}

/**
 * The provider-reported USD cost of the call, when a gateway reports one:
 * - Vercel AI Gateway: `providerMetadata.gateway.cost` (a decimal string).
 * - OpenRouter (`@openrouter/ai-sdk-provider`): `providerMetadata.openrouter.usage.cost` — what the
 *   account was actually charged for the routed provider. `total_cost` (top level or under `usage`)
 *   is the shape older integrations used, kept as a fallback.
 * A direct provider reports neither, leaving this undefined so cost is estimated from tokens.
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
      const nested = toFiniteNumber(usage.cost) ?? toFiniteNumber(usage.total_cost);
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
