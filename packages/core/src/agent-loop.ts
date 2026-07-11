import {
  publishAgentDelegated,
  publishAgentMessage,
  publishAgentQuotaExceeded,
  publishAgentRetrieved,
  publishAgentRunFinished,
  publishAgentRunStarted,
  publishAgentToolCall,
} from './diagnostics.js';
import { estimateCost } from './governance/compute.js';
import type { AgentStore } from './spi/agent-store.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { AgentPricingStore, CurrentModelPrice } from './spi/pricing-store.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Passage, Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
import { encodeStreamEvent } from './stream-events.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  AgentRunInput,
  Decision,
  MessageUsage,
  ModelMessage,
  PromptBuilder,
  PromptContext,
  PromptContributor,
  ToolCallRequest,
  ToolResult,
} from './types.js';

export interface AgentLoopDeps {
  model: ModelProvider;
  store: AgentStore;
  registry: ToolRegistry;
  rolesPolicy: RolesPolicy;
  quota?: QuotaStore;
  /**
   * Fallback accounting label when the provider's turn result doesn't report a `modelId`.
   * Optional — a provider that reports its own model makes this unnecessary.
   */
  modelId?: string;
  /** Pre-computed (YYYY-MM-DD) so the loop body stays deterministic under durable replay. */
  day: string;
  /** The agent's base prompt. A flat string, or a {@link PromptBuilder} resolved per turn. */
  systemPrompt: string | PromptBuilder;
  /**
   * Cross-agent system-prompt contributors, applied in order AFTER the agent's base prompt. Each
   * returns a section to append (or `null` to skip this turn). The app registers them via
   * `@SystemPromptContributor()`; the loop composes base + contributors into the effective prompt.
   */
  promptContributors?: PromptContributor[];
  maxSteps?: number;
  /** Optional host handle threaded to tool ctx (e.g. an ORM EntityManager). */
  host?: unknown;
  /** Agent-level tool allow-list. Undefined → all tools (after role filtering). */
  toolAllowList?: string[];
  /**
   * Per-tool execution timeout in ms. A tool that runs longer is aborted and recorded as failed
   * (the model gets the timeout as its result and can adapt) rather than hanging the turn.
   * Undefined → no timeout.
   */
  toolTimeoutMs?: number;
  /**
   * When set, after the final turn the loop makes one extra model call to propose up to this many
   * short follow-up questions, stored on the assistant message's `followUps`. Costs an extra call
   * (recorded as `follow_ups` usage). Undefined/0 → disabled.
   */
  followUpsCount?: number;
  /**
   * Enables always-on ("inject") RAG: before the turn, retrieve passages for the user message and
   * augment the system prompt with them. Its presence IS inject mode — agentic (tool) retrieval sets
   * no retriever here (it rides a normal `read` tool). Undefined → no injection.
   */
  retriever?: Retriever;
  /** How many passages inject-mode retrieval requests. Undefined → 5. */
  retrievalTopK?: number;
  /**
   * Prices each step's token usage into `costUsd` (on the `step-finish` stream frame and the
   * persisted assistant message's `usage`). The current price list is fetched ONCE per run (not per
   * message/step) and reused for every step's estimate. Undefined → `costUsd` is always `null`.
   */
  pricingStore?: AgentPricingStore;
}

/**
 * A step's cost: the provider's own reported figure when it has one (a gateway), else an estimate
 * from `price` when the model has one, else `null` — never a fabricated `0` for "we don't know".
 */
function resolveCostUsd(
  usage: MessageUsage,
  reportedCostUsd: number | undefined,
  price: CurrentModelPrice | undefined,
): number | null {
  if (reportedCostUsd !== undefined) {
    return reportedCostUsd;
  }
  return price === undefined ? null : estimateCost(usage, price);
}

/** Renders retrieved passages as a numbered, citable context block for the system prompt. */
function buildContextBlock(passages: Passage[]): string {
  const items = passages
    .map((passage, index) => {
      const label = passage.source !== undefined ? ` (${passage.source})` : '';
      return `[${index + 1}]${label} ${passage.text}`;
    })
    .join('\n\n');
  return `<retrieved_context>\n${items}\n</retrieved_context>\nUse the retrieved context above to answer when relevant, and cite sources by their bracket number.`;
}

export interface AgentLoopHooks {
  runId: string;
  /** A writer for this run's live token stream (data plane). */
  openSink(): SinkWriter | Promise<SinkWriter>;
  /** HITL gate for an action tool. Inline resolves a pending promise; durable awaits a signal. */
  awaitApproval(call: ToolCallRequest, ctx: AiToolCtx): Promise<Decision>;
  /**
   * Run another named agent and return its answer. Provided only when the host wired multi-agent
   * support (durable → child workflow, inline → nested loop). Exposed to tools as `ctx.runAgent`.
   */
  runAgent?(agentName: string, task: string): Promise<{ text: string }>;
  /**
   * Checkpoint wrapper. Inline = call fn directly; durable = ctx.step(name, fn).
   * EVERY side-effect and control-flow read goes through this so durable replay returns
   * cached results (stable ids, no double-write, no re-streaming).
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export class QuotaExceededError extends Error {
  constructor() {
    super('Daily token quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

/**
 * How deep agent→agent delegation may nest before the loop refuses further hops. A cap, not a
 * tuning knob: it stops a mis-wired `delegatesTo` cycle (A→B→A) from spawning runs unbounded.
 */
export const MAX_DELEGATION_DEPTH = 5;

/** Resolve a prompt that may be a flat string or a {@link PromptBuilder}. */
async function resolvePrompt(prompt: string | PromptBuilder, ctx: PromptContext): Promise<string> {
  return typeof prompt === 'function' ? prompt(ctx) : prompt;
}

/**
 * The effective system prompt for a turn: the agent's own base prompt, then each cross-agent
 * contributor's section appended in order (skipping any that return `null`/empty this turn). This is
 * resolved from stable inputs (actor / agent / pageContext) once per turn; contributors should be
 * derived from those rather than from uncached I/O so it stays replay-safe.
 */
async function resolveSystemPrompt(deps: AgentLoopDeps, input: AgentRunInput): Promise<string> {
  const ctx: PromptContext = {
    actor: input.actor,
    agentName: input.agentName ?? 'default',
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
  };
  const sections = [await resolvePrompt(deps.systemPrompt, ctx)];
  for (const contribute of deps.promptContributors ?? []) {
    const section = await contribute(ctx);
    if (section !== null && section.length > 0) {
      sections.push(section);
    }
  }
  return sections.join('\n\n');
}

/** An `agent`-kind tool's input is `{ task }` by convention; fall back to a JSON dump. */
function extractTask(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'task' in input) {
    const task = (input as { task: unknown }).task;
    if (typeof task === 'string') {
      return task;
    }
  }
  return JSON.stringify(input);
}

function deriveTitle(userText: string): string {
  const trimmed = userText.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || 'New chat';
}

/** Thrown when a tool exceeds `toolTimeoutMs`; caught by the loop and recorded as a failed call. */
class ToolTimeoutError extends Error {
  constructor(toolName: string, ms: number) {
    super(`Tool "${toolName}" exceeded its ${ms}ms timeout`);
    this.name = 'ToolTimeoutError';
  }
}

/** Reject if `work` doesn't settle within `ms`. The underlying work is left to finish on its own. */
function withTimeout<T>(work: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Best-effort parse of the follow-ups model reply: a bare JSON array, tolerating code fences/prose. */
function parseFollowUps(text: string, count: number): string[] {
  const source = text.match(/\[[\s\S]*\]/)?.[0] ?? text;
  try {
    const parsed: unknown = JSON.parse(source);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string').slice(0, count);
    }
  } catch {
    /* not JSON — no follow-ups this turn */
  }
  return [];
}

/**
 * One extra, non-streamed model call that proposes short follow-up questions. Writes to a discarding
 * sink so its tokens never reach the user's live stream; the reply is parsed as a JSON string array.
 */
async function generateFollowUps(
  model: ModelProvider,
  messages: ModelMessage[],
  count: number,
): Promise<{ followUps: string[]; usage: MessageUsage; modelId?: string }> {
  const discard: SinkWriter = { write: () => {}, end: () => {}, fail: () => {} };
  const turn = await model.runTurn({
    system: `Based on the conversation so far, propose up to ${count} short, distinct follow-up questions the user is likely to ask next. Respond with ONLY a JSON array of strings — no prose, no code fences.`,
    messages,
    tools: [],
    sink: discard,
  });
  return {
    followUps: parseFollowUps(turn.text, count),
    usage: turn.usage,
    ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
  };
}

/**
 * The provider-agnostic agent turn, reused by both the inline and durable runners.
 * It drives the model→tools→model iteration; the runner supplies the `step`/`awaitApproval`
 * hooks that make the same loop body either in-process or a replay-safe durable workflow.
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): Promise<{ text: string }> {
  const maxSteps = deps.maxSteps ?? 8;
  let system = await resolveSystemPrompt(deps, input);

  if (deps.quota !== undefined) {
    const quota = deps.quota;
    const state = await hooks.step('quota:check', () => quota.check(input.actor.id, deps.day));
    if (!state.withinLimit) {
      publishAgentQuotaExceeded({
        actorId: input.actor.id,
        usedTokens: state.usedTokens,
        limitTokens: state.limitTokens,
      });
      throw new QuotaExceededError();
    }
  }

  if (input.regenerate === true) {
    // Re-run the last exchange: drop every message after the thread's last user message (keeping
    // it), then answer it again. No new user message is appended.
    await hooks.step('regenerate:truncate', async () => {
      const existing = await deps.store.getThread(input.threadId);
      const messages = existing?.messages ?? [];
      let lastUserIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      const firstDropped = messages[lastUserIndex + 1];
      if (firstDropped !== undefined) {
        await deps.store.truncateFrom(input.threadId, firstDropped.id);
      }
    });
  } else {
    await hooks.step('persist:user', () =>
      deps.store.appendMessage({
        threadId: input.threadId,
        role: 'user',
        content: input.userText,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      }),
    );
  }

  const thread = await hooks.step('load:thread', () => deps.store.getThread(input.threadId));
  const modelMessages: ModelMessage[] = (thread?.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolResults !== undefined ? { toolResults: message.toolResults } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
  }));

  const writer = await hooks.openSink();
  let lastText = '';
  let steps = 0;
  let totalInput = 0;
  let totalOutput = 0;

  publishAgentRunStarted({
    runId: hooks.runId,
    threadId: input.threadId,
    actorId: input.actor.id,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
  });

  // Inject-mode RAG: retrieve once for the user message and fold the passages into the system prompt
  // (a `ctx.step` so it's replay-cached under durable). Recorded below as a synthetic tool call on
  // the first assistant message, so citations surface through the same machinery as agentic search.
  let injectedPassages: Passage[] | undefined;
  if (deps.retriever !== undefined) {
    const retriever = deps.retriever;
    const passages = await hooks.step('retrieve', () =>
      retriever.retrieve(input.userText, { topK: deps.retrievalTopK ?? 5 }),
    );
    if (passages.length > 0) {
      injectedPassages = passages;
      system = `${system}\n\n${buildContextBlock(passages)}`;
    }
    publishAgentRetrieved({ runId: hooks.runId, query: input.userText, count: passages.length });
  }

  // Fetched ONCE per run (not per step/message) and reused for every step's cost estimate below.
  // Returned as a plain array (not the Map built from it) so durable replay can JSON-cache the step.
  let prices: CurrentModelPrice[] = [];
  if (deps.pricingStore !== undefined) {
    const pricingStore = deps.pricingStore;
    prices = await hooks.step('pricing:list', () => pricingStore.listCurrentPrices());
  }
  const priceByModel = new Map(prices.map((price) => [price.modelId, price]));

  // NOTE: no try/finally around this loop. A durable runner suspends by THROWING through the stack
  // at `awaitApproval` (ctx.waitForSignal); a finally would then call writer.end() on every suspend
  // and prematurely close the live stream. We only end on normal completion — the throw propagates
  // to the engine, and the resumed replay reaches the writer.end() below.
  for (let i = 0; i < maxSteps; i += 1) {
    // Open a UI step spanning this model call AND its tool execution — matching the AI SDK's own
    // step semantics, so tool-output lands inside the step that made the call. Wrapped in a durable
    // step so replay doesn't re-emit it (a no-op for the inline runner).
    await hooks.step(`stream:step-start:${i}`, async () => {
      await writer.write(encodeStreamEvent({ kind: 'step-start' }));
    });

    const tools = await deps.registry.definitionsFor(
      input.actor,
      deps.rolesPolicy,
      deps.toolAllowList,
    );

    const turn = await hooks.step(`llm:${i}`, () =>
      deps.model.runTurn({ system, messages: modelMessages, tools, sink: writer }),
    );
    // provider-reported model wins over the configured fallback, so cost can't misattribute
    const resolvedModelId = turn.modelId ?? deps.modelId ?? 'unknown';
    // Provider-reported spend wins; else an estimate from the (once-per-run cached) price list; else
    // `null` — surfaced on the stream's step-finish frame and the persisted assistant message below.
    const costUsd = resolveCostUsd(turn.usage, turn.costUsd, priceByModel.get(resolvedModelId));
    // Stamp each call's declared kind from the registry so thread-read consumers (and the stream
    // frames the model adapter writes) know a call's kind without hardcoding a tool-name allowlist.
    const toolCallsWithKind: ToolCallRequest[] = turn.toolCalls.map((call) => ({
      ...call,
      kind: deps.registry.spec(call.name)?.kind ?? 'read',
    }));

    await hooks.step(`persist:usage:${i}`, () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        modelId: resolvedModelId,
        purpose: 'chat',
        usage: turn.usage,
        // persist the provider's actual cost when reported; the read-model prefers it over pricing
        ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
      }),
    );
    if (deps.quota !== undefined) {
      const quota = deps.quota;
      await hooks.step(`quota:bump:${i}`, () =>
        quota.bump(input.actor.id, deps.day, turn.usage.inputTokens + turn.usage.outputTokens),
      );
    }

    steps += 1;
    totalInput += turn.usage.inputTokens;
    totalOutput += turn.usage.outputTokens;
    lastText = turn.text;
    publishAgentMessage({
      runId: hooks.runId,
      threadId: input.threadId,
      role: 'assistant',
      textLength: turn.text.length,
    });

    // A turn with no tool calls is the last one. Generate follow-up suggestions here (before the
    // append) so they land on the final assistant message, and stop after.
    const isFinalTurn = turn.toolCalls.length === 0;
    let followUps: string[] | undefined;
    if (isFinalTurn && deps.followUpsCount !== undefined && deps.followUpsCount > 0) {
      const count = deps.followUpsCount;
      const generated = await hooks.step(`followups:${i}`, () =>
        generateFollowUps(
          deps.model,
          [...modelMessages, { role: 'assistant', content: turn.text }],
          count,
        ),
      );
      if (generated.followUps.length > 0) {
        followUps = generated.followUps;
      }
      await hooks.step(`persist:usage:followups:${i}`, () =>
        deps.store.recordUsage({
          threadId: input.threadId,
          actorRef: input.actor.id,
          modelId: generated.modelId ?? deps.modelId ?? 'unknown',
          purpose: 'follow_ups',
          usage: generated.usage,
        }),
      );
    }

    const assistant = await hooks.step(`persist:assistant:${i}`, () =>
      deps.store.appendMessage({
        threadId: input.threadId,
        role: 'assistant',
        content: turn.text,
        usage: { ...turn.usage, costUsd },
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(toolCallsWithKind.length > 0 ? { toolCalls: toolCallsWithKind } : {}),
        ...(followUps !== undefined ? { followUps } : {}),
      }),
    );
    // Tool results ride on the same assistant message that made the calls — the compact shape the
    // store persists and `mapMessages` (in every model adapter) expands into an assistant + tool
    // message pair. We keep the reference and attach `toolResults` below once the tools have run.
    const assistantMessage: ModelMessage = {
      role: 'assistant',
      content: turn.text,
      ...(toolCallsWithKind.length > 0 ? { toolCalls: toolCallsWithKind } : {}),
    };
    modelMessages.push(assistantMessage);

    // Record inject-mode retrieval as a synthetic auto-executed `retrieve` tool call on the assistant
    // message it informed — so its passages persist and render as citations exactly like an agentic
    // search would, without a new message field.
    if (i === 0 && injectedPassages !== undefined) {
      const passages = injectedPassages;
      const toolCallId = `retrieve-${assistant.id}`;
      await hooks.step(`persist:retrieval:${assistant.id}`, async () => {
        await deps.store.recordToolCall({
          toolCallId,
          messageId: assistant.id,
          toolName: 'retrieve',
          toolType: 'read',
          input: { query: input.userText },
          status: 'auto_executed',
        });
        await deps.store.updateToolCall({ toolCallId, status: 'executed', output: { passages } });
      });
    }

    if (isFinalTurn) {
      await hooks.step(`stream:step-finish:${i}`, async () => {
        await writer.write(encodeStreamEvent({ kind: 'step-finish', usage: turn.usage, costUsd }));
      });
      break;
    }

    const results: ToolResult[] = [];
    for (const call of toolCallsWithKind) {
      const spec = deps.registry.spec(call.name);
      const toolType = call.kind ?? 'read';
      const ctx: AiToolCtx = {
        actor: input.actor,
        threadId: input.threadId,
        runId: hooks.runId,
        requestId: hooks.runId,
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
        ...(deps.host !== undefined ? { host: deps.host } : {}),
      };

      // Delegation: an `agent`-kind tool runs another agent. Handled at the LOOP level (not in a
      // step) because the durable runner maps it to `ctx.child`, a ctx-level suspend point.
      if (toolType === 'agent') {
        const targetAgent = spec?.targetAgent ?? call.name;
        const task = extractTask(call.input);
        await hooks.step(`persist:toolcall:${call.id}`, () =>
          deps.store.recordToolCall({
            toolCallId: call.id,
            messageId: assistant.id,
            toolName: call.name,
            toolType: 'read',
            input: call.input,
            status: 'auto_executed',
          }),
        );
        // Cap nesting so a mis-wired delegation cycle can't spawn runs without bound.
        const overDepth = (input.delegationDepth ?? 0) >= MAX_DELEGATION_DEPTH;
        publishAgentDelegated({
          runId: hooks.runId,
          toAgent: targetAgent,
          ...(input.agentName !== undefined ? { fromAgent: input.agentName } : {}),
        });
        let sub: { text: string };
        if (overDepth) {
          sub = { text: `(delegation depth limit of ${MAX_DELEGATION_DEPTH} reached)` };
        } else if (hooks.runAgent) {
          sub = await hooks.runAgent(targetAgent, task);
        } else {
          sub = { text: `(no multi-agent support wired; cannot reach "${targetAgent}")` };
        }
        await hooks.step(`persist:toolexec:${call.id}`, () =>
          deps.store.updateToolCall({ toolCallId: call.id, status: 'executed', output: sub }),
        );
        results.push({ id: call.id, name: call.name, output: sub });
        continue;
      }

      if (toolType === 'action') {
        await hooks.step(`persist:toolcall:${call.id}`, () =>
          deps.store.recordToolCall({
            toolCallId: call.id,
            messageId: assistant.id,
            toolName: call.name,
            toolType: 'action',
            input: call.input,
            status: 'pending_approval',
          }),
        );
        const decision = await hooks.awaitApproval(call, ctx);
        if (!decision.approved) {
          await hooks.step(`persist:toolreject:${call.id}`, () =>
            deps.store.updateToolCall({
              toolCallId: call.id,
              status: 'rejected',
              ...(decision.reason !== undefined ? { error: decision.reason } : {}),
            }),
          );
          results.push({
            id: call.id,
            name: call.name,
            output: { rejected: true, reason: decision.reason ?? 'rejected by user' },
            error: 'rejected',
          });
          publishAgentToolCall({
            runId: hooks.runId,
            toolName: call.name,
            toolType,
            status: 'rejected',
          });
          continue;
        }
      } else {
        await hooks.step(`persist:toolcall:${call.id}`, () =>
          deps.store.recordToolCall({
            toolCallId: call.id,
            messageId: assistant.id,
            toolName: call.name,
            toolType: 'read',
            input: call.input,
            status: 'auto_executed',
          }),
        );
      }

      const startedAt = Date.now();
      try {
        const invocation = hooks.step(`tool:${call.id}`, () =>
          deps.registry.invoke(call.name, call.input, ctx, deps.rolesPolicy),
        );
        const output =
          deps.toolTimeoutMs !== undefined
            ? await withTimeout(invocation, deps.toolTimeoutMs, call.name)
            : await invocation;
        const executionMs = Date.now() - startedAt;
        await hooks.step(`persist:toolexec:${call.id}`, () =>
          deps.store.updateToolCall({
            toolCallId: call.id,
            status: 'executed',
            output,
            executionMs,
            ...(toolType === 'action' ? { executedByRef: input.actor.id } : {}),
          }),
        );
        results.push({ id: call.id, name: call.name, output });
        publishAgentToolCall({
          runId: hooks.runId,
          toolName: call.name,
          toolType,
          status: 'executed',
          durationMs: executionMs,
        });
      } catch (error) {
        const executionMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        await hooks.step(`persist:toolfail:${call.id}`, () =>
          deps.store.updateToolCall({
            toolCallId: call.id,
            status: 'failed',
            error: message,
            executionMs,
          }),
        );
        results.push({ id: call.id, name: call.name, output: null, error: message });
        publishAgentToolCall({
          runId: hooks.runId,
          toolName: call.name,
          toolType,
          status: 'failed',
          durationMs: executionMs,
        });
      }
    }

    assistantMessage.toolResults = results;

    // Stream each tool's result so the client flips its live tool card from "running" to the
    // rendered output (renderResult → DataTable/Chart, executeSql → rows). One durable step keeps
    // replay from re-emitting. `error` covers both a thrown tool and a rejected action.
    await hooks.step(`stream:tool-outputs:${i}`, async () => {
      for (const result of results) {
        await writer.write(
          encodeStreamEvent(
            result.error !== undefined
              ? { kind: 'tool-output-error', id: result.id, error: result.error }
              : { kind: 'tool-output', id: result.id, output: result.output },
          ),
        );
      }
    });

    await hooks.step(`stream:step-finish:${i}`, async () => {
      await writer.write(encodeStreamEvent({ kind: 'step-finish', usage: turn.usage, costUsd }));
    });
  }

  if (thread !== null && (thread.title === '' || thread.title === 'New chat')) {
    await hooks.step('persist:title', () =>
      deps.store.setTitle(input.threadId, deriveTitle(input.userText)),
    );
  }

  await writer.end();
  publishAgentRunFinished({
    runId: hooks.runId,
    threadId: input.threadId,
    steps,
    inputTokens: totalInput,
    outputTokens: totalOutput,
  });
  return { text: lastText };
}
