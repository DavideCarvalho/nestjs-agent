import {
  publishAgentDelegated,
  publishAgentMessage,
  publishAgentRunFinished,
  publishAgentRunStarted,
  publishAgentToolCall,
} from './diagnostics.js';
import type { AgentStore } from './spi/agent-store.js';
import type { ModelProvider } from './spi/model-provider.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  AgentRunInput,
  Decision,
  ModelMessage,
  PromptBuilder,
  PromptContext,
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
  maxSteps?: number;
  /** Optional host handle threaded to tool ctx (e.g. an ORM EntityManager). */
  host?: unknown;
  /** Agent-level tool allow-list (intersected with the persona's). Undefined → all tools. */
  toolAllowList?: string[];
}

/** Intersect two allow-lists where `undefined` means "no restriction". */
function intersectAllow(a?: string[], b?: string[]): string[] | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  const second = new Set(b);
  return a.filter((name) => second.has(name));
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

/** Resolve a prompt that may be a flat string or a {@link PromptBuilder}. */
async function resolvePrompt(prompt: string | PromptBuilder, ctx: PromptContext): Promise<string> {
  return typeof prompt === 'function' ? prompt(ctx) : prompt;
}

/**
 * The effective system prompt for a turn: resolve the agent's base prompt first, then — if the
 * request selected a persona — resolve the persona prompt with that base as `basePrompt`, so a
 * persona builder can wrap the agent's base rather than discard it.
 */
async function resolveSystemPrompt(deps: AgentLoopDeps, input: AgentRunInput): Promise<string> {
  const base: Omit<PromptContext, 'basePrompt'> = {
    actor: input.actor,
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
  };
  const basePrompt = await resolvePrompt(deps.systemPrompt, { ...base, basePrompt: '' });
  if (input.persona === undefined) {
    return basePrompt;
  }
  return resolvePrompt(input.persona.systemPrompt, { ...base, basePrompt });
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
  const persona = input.persona;
  const system = await resolveSystemPrompt(deps, input);

  if (deps.quota !== undefined) {
    const quota = deps.quota;
    const state = await hooks.step('quota:check', () => quota.check(input.actor.id, deps.day));
    if (!state.withinLimit) {
      throw new QuotaExceededError();
    }
  }

  await hooks.step('persist:user', () =>
    deps.store.appendMessage({
      threadId: input.threadId,
      role: 'user',
      content: input.userText,
      ...(persona !== undefined ? { persona: persona.id } : {}),
    }),
  );

  const thread = await hooks.step('load:thread', () => deps.store.getThread(input.threadId));
  const modelMessages: ModelMessage[] = (thread?.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolResults !== undefined ? { toolResults: message.toolResults } : {}),
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
    ...(persona !== undefined ? { persona: persona.id } : {}),
  });

  // NOTE: no try/finally around this loop. A durable runner suspends by THROWING through the stack
  // at `awaitApproval` (ctx.waitForSignal); a finally would then call writer.end() on every suspend
  // and prematurely close the live stream. We only end on normal completion — the throw propagates
  // to the engine, and the resumed replay reaches the writer.end() below.
  for (let i = 0; i < maxSteps; i += 1) {
    const tools = await deps.registry.definitionsFor(
      input.actor,
      deps.rolesPolicy,
      intersectAllow(persona?.allowedTools, deps.toolAllowList),
    );

    const turn = await hooks.step(`llm:${i}`, () =>
      deps.model.runTurn({ system, messages: modelMessages, tools, sink: writer }),
    );

    await hooks.step(`persist:usage:${i}`, () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        // provider-reported model wins over the configured fallback, so cost can't misattribute
        modelId: turn.modelId ?? deps.modelId ?? 'unknown',
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
    const assistant = await hooks.step(`persist:assistant:${i}`, () =>
      deps.store.appendMessage({
        threadId: input.threadId,
        role: 'assistant',
        content: turn.text,
        usage: turn.usage,
        ...(persona !== undefined ? { persona: persona.id } : {}),
        ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
      }),
    );
    modelMessages.push({
      role: 'assistant',
      content: turn.text,
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
    });

    if (turn.toolCalls.length === 0) {
      break;
    }

    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      const spec = deps.registry.spec(call.name);
      const toolType = spec?.kind ?? 'read';
      const ctx: AiToolCtx = {
        actor: input.actor,
        threadId: input.threadId,
        runId: hooks.runId,
        requestId: hooks.runId,
        ...(persona !== undefined ? { persona } : {}),
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
        publishAgentDelegated({
          runId: hooks.runId,
          toAgent: targetAgent,
          ...(input.agentName !== undefined ? { fromAgent: input.agentName } : {}),
        });
        const sub = hooks.runAgent
          ? await hooks.runAgent(targetAgent, task)
          : { text: `(no multi-agent support wired; cannot reach "${targetAgent}")` };
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

      try {
        const output = await hooks.step(`tool:${call.id}`, () =>
          deps.registry.invoke(call.name, call.input, ctx, deps.rolesPolicy),
        );
        await hooks.step(`persist:toolexec:${call.id}`, () =>
          deps.store.updateToolCall({
            toolCallId: call.id,
            status: 'executed',
            output,
            ...(toolType === 'action' ? { executedByRef: input.actor.id } : {}),
          }),
        );
        results.push({ id: call.id, name: call.name, output });
        publishAgentToolCall({
          runId: hooks.runId,
          toolName: call.name,
          toolType,
          status: 'executed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await hooks.step(`persist:toolfail:${call.id}`, () =>
          deps.store.updateToolCall({ toolCallId: call.id, status: 'failed', error: message }),
        );
        results.push({ id: call.id, name: call.name, output: null, error: message });
        publishAgentToolCall({
          runId: hooks.runId,
          toolName: call.name,
          toolType,
          status: 'failed',
        });
      }
    }

    modelMessages.push({ role: 'user', content: '', toolResults: results });
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
