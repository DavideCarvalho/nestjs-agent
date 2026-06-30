import type { ModelProvider } from './spi/model-provider.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
import type { AgentStore } from './spi/agent-store.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  publishAgentDelegated,
  publishAgentMessage,
  publishAgentRunFinished,
  publishAgentRunStarted,
  publishAgentToolCall,
} from './diagnostics.js';
import type {
  AgentRunInput,
  Decision,
  ModelMessage,
  ToolCallRequest,
  ToolResult,
} from './types.js';

export interface AgentLoopDeps {
  model: ModelProvider;
  store: AgentStore;
  registry: ToolRegistry;
  rolesPolicy: RolesPolicy;
  quota?: QuotaStore;
  modelId: string;
  /** Pre-computed (YYYY-MM-DD) so the loop body stays deterministic under durable replay. */
  day: string;
  systemPrompt: string;
  maxSteps?: number;
  /** Optional host handle threaded to tool ctx (e.g. an ORM EntityManager). */
  host?: unknown;
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
  const system = persona?.systemPrompt ?? deps.systemPrompt;

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

  // NOTE: no try/finally around the loop. A durable runner suspends by THROWING through the
  // stack at `awaitApproval` (ctx.waitForSignal); a finally would then call writer.end() on
  // every suspend and prematurely close the live stream. We only end on normal completion —
  // the throw propagates to the engine, and the resumed replay reaches the end() below.
  {
    for (let i = 0; i < maxSteps; i += 1) {
      const tools = deps.registry.definitionsFor(
        input.actor,
        deps.rolesPolicy,
        persona?.allowedTools,
      );

      const turn = await hooks.step(`llm:${i}`, () =>
        deps.model.runTurn({ system, messages: modelMessages, tools, sink: writer }),
      );

      await hooks.step(`persist:usage:${i}`, () =>
        deps.store.recordUsage({
          threadId: input.threadId,
          actorRef: input.actor.id,
          modelId: deps.modelId,
          purpose: 'chat',
          usage: turn.usage,
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
          actorId: input.actor.id,
          threadId: input.threadId,
          runId: hooks.runId,
          requestId: hooks.runId,
          actor: input.actor,
          ...(input.actor.role !== undefined ? { actorRole: input.actor.role } : {}),
          ...(input.actor.tenantRef !== undefined ? { tenantRef: input.actor.tenantRef } : {}),
          ...(persona !== undefined ? { persona } : {}),
          ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
          ...(deps.host !== undefined ? { host: deps.host } : {}),
          ...(hooks.runAgent !== undefined
            ? {
                runAgent: (agentName: string, task: string) => {
                  publishAgentDelegated({
                    runId: hooks.runId,
                    toAgent: agentName,
                    ...(input.agentName !== undefined ? { fromAgent: input.agentName } : {}),
                  });
                  // biome-ignore lint/style/noNonNullAssertion: guarded by the spread condition
                  return hooks.runAgent!(agentName, task);
                },
              }
            : {}),
        };

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
