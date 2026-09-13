import { createHash } from 'node:crypto';
import { trace } from '@dudousxd/nestjs-diagnostics';
import type { PayloadOf } from '@dudousxd/nestjs-diagnostics';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { isControlFlowSignal } from './control-flow.js';
import {
  type DetachedDelegationReceipt,
  detachedDelivered,
  detachedStarted,
} from './delegation.js';
import {
  type AgentSpanEvent,
  publishAgentDelegated,
  publishAgentMemoryResolved,
  publishAgentMemoryWritten,
  publishAgentMessage,
  publishAgentQuotaExceeded,
  publishAgentRetrieved,
  publishAgentRunFinished,
  publishAgentRunStarted,
  publishAgentSkillsResolved,
  publishAgentToolCall,
  publishAgentToolRetry,
} from './diagnostics.js';
import {
  ASK_TOOL_NAME,
  type AgentIntake,
  DEFAULT_INTAKE_PREAMBLE,
  type ElicitationReply,
  type ElicitationRequest,
  type ElicitationResult,
  askInputSchema,
  askToolDefinition,
  normalizeElicitationReply,
  settleElicitation,
} from './elicitation.js';
import { estimateCost } from './governance/compute.js';
import {
  type MemoryConfig,
  type MemoryDigest,
  type MemoryRecord,
  REMEMBER_TOOL_NAME,
  buildMemoryBlock,
  offerMemories,
  rememberInputSchema,
  withMemoryTool,
  writeMemory,
} from './memory.js';
import {
  createFrameBuffer,
  createIncrementalGate,
  gateFollowUps,
  gateTail,
  releaseGatedFrames,
  resolveGateLookback,
  resolveOutputGateMode,
  runInputProcessors,
  runOutputProcessors,
} from './processors.js';
import { isReplayIntegrityError } from './replay-integrity.js';
import {
  SKILL_TOOL_NAME,
  type SkillContext,
  type SkillOffer,
  type SkillsConfig,
  buildSkillsBlock,
  loadSkill,
  offerSkills,
  skillInputSchema,
  withSkillTool,
} from './skills.js';
import type { AgentStore, ThreadTurnReader } from './spi/agent-store.js';
import type {
  HistoryPolicy,
  HistoryPolicyContext,
  HistorySelection,
} from './spi/history-policy.js';
import type {
  BufferedModelTurnResult,
  ModelProvider,
  ModelTurnResult,
} from './spi/model-provider.js';
import type { AgentPricingStore, CurrentModelPrice } from './spi/pricing-store.js';
import {
  type InputProcessor,
  type OutputProcessor,
  OutputRejectedError,
  type ProcessedPrompt,
  type ProcessorContext,
} from './spi/processors.js';
import type { QuotaStore } from './spi/quota-store.js';
import type { Passage, Retriever } from './spi/retriever.js';
import type { RolesPolicy } from './spi/roles-policy.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { AiToolCtx } from './spi/tool.js';
import { type AgentStreamEvent, encodeStreamEvent } from './stream-events.js';
import {
  DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION,
  StructuredOutputError,
  repairInstruction,
  validateStructured,
} from './structured-output.js';
import type { ToolRegistry } from './tool-registry.js';
import { invokeWithTransientRetry, resolveToolTransientRetryNumbers } from './tool-retry.js';
import type { ToolTransientRetrySetting } from './tool-retry.js';
import type {
  AgentRunInput,
  Decision,
  HumanReply,
  LlmStepEnvelope,
  MessageUsage,
  ModelMessage,
  PromptBuilder,
  PromptContext,
  PromptContributor,
  StoredMessage,
  ToolCallRequest,
  ToolDefinition,
  ToolKind,
  ToolResult,
  ToolStepCtx,
  ToolStepEnvelope,
} from './types.js';

export interface AgentLoopDeps<TOutput = unknown> {
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
  /**
   * How deep agent→agent delegation may nest before the loop refuses further hops.
   * Defaults to {@link MAX_DELEGATION_DEPTH}.
   *
   * It bounds NESTING, never fan-out: how many agents a turn delegates to is the model's, one tool
   * call each, and nothing here caps that. What it guards is a hop the model cannot see — a
   * `delegatesTo` cycle (A→B→A), where each agent is making one reasonable call and the recursion
   * is a property of the wiring rather than of any decision.
   */
  maxDelegationDepth?: number;
  /**
   * How many times one agent may appear on a single delegation chain.
   * Defaults to {@link DEFAULT_MAX_AGENT_APPEARANCES}.
   *
   * This is the guard the depth ceiling was a proxy for, made exact: the loop compares the target
   * against {@link AgentRunInput.delegationPath} and knows whether the chain has been here before,
   * and how often. A chain of eight DISTINCT agents is long, not looping, and no longer refused for
   * resembling one.
   */
  maxAgentAppearances?: number;
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
   * Retries a tool's own invocation, in place, when it throws a classified-transient error (a DB
   * deadlock, a lock-wait timeout, a serialization failure — see `isTransientToolError`) — never a
   * new durable step/checkpoint, just repeated attempts inside the same `tool:<call.id>` step body.
   * Default ON (`{ attempts: 2, backoffMs: 150 }` with the default classifier) when undefined; set
   * `{ classify }` to widen/narrow which errors count as transient, or `false` to disable entirely.
   * A tool's other (non-transient) failures are unaffected — they remain a one-shot business
   * outcome, exactly as before.
   */
  toolTransientRetry?: ToolTransientRetrySetting;
  /**
   * When set, after the final turn the loop makes one extra model call to propose up to this many
   * short follow-up questions, stored on the assistant message's `followUps`. Costs an extra call
   * (recorded as `follow_ups` usage). Undefined/0 → disabled.
   */
  followUpsCount?: number;
  /**
   * Enables always-on ("inject") RAG: before the turn, retrieve passages for the user message and
   * augment the system prompt with them. Its presence IS inject mode — agentic (tool) retrieval sets
   * no retriever here (it rides a normal `read` tool). Undefined → no injection, and no `retrieve`
   * position: which answer a RUN got is journaled (see {@link PromptStages}), so wiring one does not
   * move the checkpoints of a turn already in flight.
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
  /**
   * Bounds how much of the thread rides into the turn. Undefined → the WHOLE thread, every message
   * the store holds, which is unbounded: a long-lived thread eventually exceeds the provider's
   * context limit, and pays for the full transcript on every turn up to that point. See
   * `windowHistory` for the built-in.
   */
  historyPolicy?: HistoryPolicy;
  /**
   * Rewrites the prompt before EACH model call of the turn, in order (see {@link InputProcessor}).
   * Transformation only — `historyPolicy` owns which messages are there in the first place. Adds
   * one `process:input:<step>` checkpoint per step; empty/undefined adds none.
   */
  inputProcessors?: InputProcessor[];
  /**
   * Inspects each model step's answer before the stream, the store or the next step sees it, and
   * may redact, replace or refuse it (see {@link OutputProcessor}).
   *
   * REGISTERING ONE TAKES THE MODEL CALL OFF THE RUN'S SINK for the turn — a gate cannot run after
   * the answer has already reached the reader. What the chain costs the subscriber depends on what
   * it declares:
   *
   * - Any processor WITHOUT `incremental` → the whole answer is buffered and released as one `text`
   *   frame once the chain has passed. No token-by-token text, and (for a provider that writes bytes
   *   outside the `AgentStreamEvent` vocabulary) no frame the gate cannot classify.
   * - EVERY processor with `incremental` → the chain runs over the growing prefix and releases it as
   *   it arrives, holding back the widest `lookbackChars` any of them asked for. The whole-answer
   *   pass still runs and is still authoritative for the stream and the store.
   *
   * Both add one `process:output:<step>` checkpoint per step, in the same position, so a chain can
   * change its declaration without moving a checkpoint. Empty/undefined adds none, and the turn
   * streams exactly as it always did.
   */
  outputProcessors?: OutputProcessor[];
  /**
   * Constrain the turn's answer to a schema, returned validated as `object` on the loop's result and
   * recorded on the assistant message as a synthetic `structured_output` tool call (the same shape
   * inject-mode retrieval uses, so no store gains a column for it).
   *
   * HOW IT COMPOSES WITH TOOL CALLING: as a separate formatting pass, ALWAYS. The turn runs its
   * model→tools iteration exactly as it would without a schema; once a step comes back with no tool
   * calls, one extra non-streamed call (`structured:<step>`, `tools: []`, `outputSchema` set)
   * restates that answer as the schema. Most providers cannot serve a response format and a tool set
   * in one request, and skipping the pass for an agent that happens to have no tools would make the
   * checkpoint sequence depend on a tool-registry lookup — the registry of whichever process is
   * replaying — which is exactly how a run ends up asking for a position its history has no room
   * for. So the pass is unconditional, and it costs one model call per turn (recorded as
   * `structured_output` usage).
   */
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  /** Overrides the formatting pass's system prompt. Undefined → `DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION`. */
  outputInstruction?: string;
  /**
   * How many extra model calls may try to fix an answer that failed `outputSchema`, each shown the
   * previous attempt's validation issues. Undefined → 1; `0` → fail on the first invalid reply.
   * Bounded because a model that cannot satisfy a schema usually cannot satisfy it on the fourth
   * try either, and every attempt is billed.
   */
  outputRepairAttempts?: number;
  /**
   * Show the formatting pass the turn's whole transcript instead of just the question and the
   * answer. For an agent whose answer cannot be restated from its own words — one that reports on
   * rows a tool returned and names only their total in the prose, say.
   *
   * OFF by default because the pass is a translation, and a translation needs the thing being
   * translated. The transcript it would otherwise carry is the turn's entire prompt a second time,
   * at no discount: the pass swaps the system block for the schema instruction, and the system block
   * is the prompt cache's prefix, so nothing of the first call's cache survives into it.
   */
  outputFromTranscript?: boolean;
  /**
   * A question set the agent puts to the user BEFORE it starts working — collecting the scope, as
   * against `awaitApproval`, which sanctions work already proposed. The questions are AUTHORED, so
   * the turn spends no model call producing them and a client knows the total ("Question 1 of 3")
   * the moment the form appears.
   *
   * The turn parks on the answers exactly as it parks on an approval, and the request persists as
   * the same tool-call row the model's `ask` writes — see {@link ask}. Undefined → no intake, and a
   * turn's checkpoint sequence is byte-identical to one that never had the option.
   */
  intake?: AgentIntake;
  /**
   * Offer the model the built-in `ask` tool, so it can put its own question set to the user when it
   * judges the scope is missing — the same surface as {@link intake}, minus the "known in advance".
   *
   * `ask` is NOT a registered tool: it has no handler (the loop settles it against a human), and
   * keeping it out of the `ToolRegistry` is what keeps its kind out of a process-local lookup. The
   * loop appends its definition to the turn's tool list from THIS flag, which is module config and
   * therefore uniform across a deployment. Undefined/false → the model never sees it.
   */
  ask?: boolean;
  /**
   * Authored procedures the model may pull in when a task calls for one, resolved per turn against
   * the actor's scopes — see `skills.ts`. Undefined → no catalog block, no `skill` tool, and a
   * turn's checkpoint sequence is byte-identical to one that never had the option — including for a
   * turn that was already in flight when this was wired, because which answer a RUN got is journaled
   * (see {@link PromptStages}).
   *
   * HOW IT COMPOSES WITH THE OTHER FOUR THINGS THAT WRITE THE PROMPT. The system block is assembled
   * in one fixed order — the agent's base prompt, then each `promptContributors` section, then
   * {@link memory}, then the injected retrieval block, then the skills CATALOG — and skills are the
   * cheapest of the five by construction: the catalog is one line per skill and nothing else. The
   * instructions themselves arrive as a tool RESULT, on the transcript, which means the budget they
   * draw on is the one `historyPolicy` already governs rather than a private allowance of their own.
   *
   * A BODY IS NOT LIKE A MEMORY, which does ride the system block. A body is read BECAUSE the model
   * went and asked for it, so the transcript — what this conversation happened to pull in — is where
   * it belongs. A memory is worthless unless it is in front of the model on the turn nobody thought
   * to look for it, and it is affordable there only because it has no body to carry.
   */
  skills?: SkillsConfig;
  /**
   * What the assistant has previously concluded about the actor and their organisation, resolved per
   * turn against the same scope tokens skills use — see `memory.ts`. Undefined → no memory block, no
   * `remember` tool, and a turn's checkpoint sequence is byte-identical to one that never had the
   * option — including for a turn that was already in flight when this was wired, because which
   * answer a RUN got is journaled (see {@link PromptStages}).
   *
   * WHERE IT SITS IN THE PROMPT. The system block is assembled most-durable-first: the agent's base
   * prompt (the same for everyone, every turn), then `promptContributors`, then MEMORY (the same for
   * this person, every turn), then the injected retrieval block (this question only), then the
   * skills catalog (a menu rather than an instruction, so a reader meets instructions before
   * options).
   *
   * WHY IT IS IN THE SYSTEM BLOCK AT ALL, when a skill's body deliberately is not. A body is read
   * BECAUSE the model went and asked for it; a memory is worthless unless it is in front of the
   * model on the turn nobody thought to look for it — "they report in nautical miles" only works
   * unprompted. What makes that affordable is that a memory has no body: `maxMemories` lines, each
   * capped at `maxFactChars` when it is written, so the block's ceiling is a product of two numbers
   * an operator set rather than however much the model felt like writing down.
   */
  memory?: MemoryConfig;
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

/** Renders a folded-history summary as the leading `system` message of a windowed turn. */
function buildSummaryBlock(summary: string): string {
  return `<conversation_summary>\n${summary}\n</conversation_summary>\nEarlier messages in this thread are no longer included verbatim. Treat the summary above as an accurate record of them.`;
}

/** One task's outcome under {@link AgentLoopHooks.parallel}, reported instead of thrown. */
export type SettledTask<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * The {@link AgentLoopHooks.parallel} implementation for a runner whose checkpoint positions are
 * handed out on the CALL (both durable primitives are: `ctx.localStep` and `ctx.step` take their
 * position before their first `await`). Every task is invoked here, synchronously and in list
 * order, before any of them is awaited — which is what fixes the block of positions the tasks
 * occupy, whatever order they then settle in. Nothing rejects: the caller decides what an
 * individual failure means.
 */
export function settleAll<T>(tasks: readonly (() => Promise<T>)[]): Promise<SettledTask<T>[]> {
  const started = tasks.map((task) => task());
  return Promise.all(
    started.map((work) =>
      work.then<SettledTask<T>, SettledTask<T>>(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      ),
    ),
  );
}

export interface AgentLoopHooks {
  runId: string;
  /** A writer for this run's live token stream (data plane). */
  openSink(): SinkWriter | Promise<SinkWriter>;
  /** HITL gate for an action tool. Inline resolves a pending promise; durable awaits a signal. */
  awaitApproval(call: ToolCallRequest, ctx: AiToolCtx): Promise<Decision>;
  /**
   * Park the run on a question set and resolve with what the human sent back. The SAME wait
   * `awaitApproval` is — the durable runner maps both to `ctx.waitForSignal` on
   * `tool:<runId>:<callId>`, so an answer and an approval reach a parked run through one path.
   *
   * Optional, and its absence changes no checkpoint: the loop falls back to `awaitApproval` and
   * reads the decision as "the user confirmed the pre-picked answers" (approved) or "the user
   * skipped" (rejected). That is the honest reduction of a yes/no channel, and it means a host that
   * only ever implemented approval still runs an elicitation to completion instead of hanging.
   *
   * Declared as `HumanReply` rather than `ElicitationReply` because that is what the channel really
   * carries: a question set is parked as a `pending_approval` action, so a `Decision` can arrive on
   * this wait from the approvals inbox even where the host implements it. The loop reduces one to
   * the other — see {@link normalizeElicitationReply} — so an implementer never has to.
   */
  awaitAnswers?(request: ElicitationRequest, ctx: AiToolCtx): Promise<HumanReply>;
  /**
   * Run another named agent and return its answer. Provided only when the host wired multi-agent
   * support (durable → child workflow, inline → nested loop). Exposed to tools as `ctx.runAgent`.
   */
  runAgent?(agentName: string, task: string): Promise<{ text: string }>;
  /**
   * Start another named agent and return its run id WITHOUT waiting for it, so the calling turn can
   * finish while the delegate is still working. The durable runner maps this to `ctx.startChild`
   * (checkpointed as `spawn:<id>`; no suspend, unlike the `ctx.child` behind {@link runAgent}); the
   * inline runner to a nested loop nobody awaits.
   *
   * `toolCallId` is the delegation's own call, which the started run carries as its delivery
   * address: it posts its answer back into the calling thread against that row.
   *
   * Absent -> a delegation the journal declares detached is AWAITED instead. The loop writes the
   * same checkpoint names either way (see {@link delegateToolCall}), so a runner that cannot detach
   * still answers the user; only the runner's own positions differ, and a given runner always makes
   * the same choice for the same call.
   */
  startAgent?(args: {
    agentName: string;
    task: string;
    toolCallId: string;
  }): Promise<{ runId: string }>;
  /**
   * Checkpoint wrapper. Inline = call fn directly; durable = ctx.localStep(name, fn) — the
   * in-process checkpointed primitive (`name` is a checkpoint identity, not a worker group).
   * EVERY side-effect and control-flow read goes through this so durable replay returns
   * cached results (stable ids, no double-write, no re-streaming).
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Dispatch the model turn as a routed remote step. When present the loop uses it INSTEAD of
   * running the model inline under hooks.step. Must resolve to exactly what deps.model.runTurn
   * resolves, plus `bufferedFrames` when (and only when) the envelope set `bufferOutput` — the
   * handler streams to a worker-side sink the loop cannot wrap, so an output gate depends on it
   * honouring that flag. The durable runner enriches the envelope with sink routing
   * (sinkRunId/childSink) on its side — core stays sink-topology-agnostic.
   */
  dispatchLlm?(index: number, envelope: LlmStepEnvelope): Promise<BufferedModelTurnResult>;
  /**
   * Dispatch one tool execution as a routed remote step. Replaces ONLY the registry.invoke call
   * (+ its timeout, applied handler-side); all persist steps around it stay local.
   */
  dispatchTool?(call: ToolCallRequest, envelope: ToolStepEnvelope): Promise<unknown>;
  /**
   * Recognizes the runner's control-flow signals (durable suspend / continue-as-new) so the loop
   * rethrows them untouched instead of recording a failure. An OVERRIDE, not the gate: the loop
   * already recognizes any signal carrying the durable runtime's `Symbol.for` marker on its own (see
   * {@link isControlFlowSignal}), so a host that omits this — an inline runner with no control-flow
   * exceptions, or one that simply forgot — never turns a suspend into a persisted tool failure.
   * Supply it for a runner whose signals carry no marker.
   */
  isControlFlowError?(error: unknown): boolean;
  /**
   * Run `tasks` concurrently, resolving once EVERY one has settled — one outcome per task, in INPUT
   * order, never rejecting. Supplying it is a statement about the runner's checkpointing: each task
   * MUST be invoked synchronously, in list order, before any is awaited, so a runner that hands out
   * positions on the call assigns them in that order regardless of which task finishes first.
   * {@link settleAll} is exactly that, and is what both bundled runners pass.
   *
   * Waiting for ALL of them is the other half of the contract. A durable runner unwinds a turn by
   * THROWING (a dispatched step suspends), and a sibling abandoned part-way through its own dispatch
   * is a tool nobody ever runs.
   *
   * Absent → the loop runs a turn's tool calls one at a time. That is the honest answer for a runner
   * whose positions are assigned anywhere other than the call, and it is the only behaviour that
   * existed before, so nothing gains concurrency without saying so.
   */
  parallel?<T>(tasks: readonly (() => Promise<T>)[]): Promise<SettledTask<T>[]>;
  /**
   * Has someone asked this run to stop?
   *
   * Answered at the points where stopping is safe and cheap — between steps, before the next model
   * call, before the turn's tools are dispatched — and NEVER consulted anywhere else. Two properties
   * make it safe to ask a live question inside a replayed loop body:
   *
   * 1. THE ANSWER IS JOURNALED. The loop only ever calls this inside a checkpoint, so the first
   *    process to reach a given position writes the answer there and every later replay reads it
   *    back. A cancel that arrives between two replays is therefore seen at the first position the
   *    history does NOT yet hold, and cannot change the branch a replayed position already took.
   * 2. THE POSITIONS ARE PATCHED IN. They exist only for a run that {@link patched} admits to the
   *    `agent:cancellation` shape, so a run already in flight when a deployment gained this keeps
   *    replaying against the sequence it recorded.
   *
   * Undefined → the run cannot be cancelled and takes not one extra checkpoint, which is the honest
   * answer for a host with nowhere to record the request.
   *
   * WHAT IT CANNOT REACH: a turn parked on a human (`awaitApproval`/`awaitAnswers`) is suspended
   * INSIDE a position the journal already holds, so no observation of any kind fires there. Stopping
   * a parked run is the runner's job, through whatever hard cancel its runtime has.
   */
  cancelled?(): Promise<boolean>;
  /**
   * Does this run take the loop shape guarded by `id`? A runner replaying against recorded
   * checkpoints answers `false` for a run that started before the shape changed, so that run keeps
   * replaying the shape its history holds (the durable runtime's `ctx.patched`, which consumes a
   * position for a new run and gives it back to an old one). Absent → `true`: a runner that records
   * no positions has no older shape to preserve.
   */
  patched?(id: string): Promise<boolean>;
}

export class QuotaExceededError extends Error {
  constructor() {
    super('Daily token quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

/**
 * Someone asked this run to stop, and it did. NOT a failure — it is the outcome a user pressing Stop
 * is entitled to, and a consumer whose reliability numbers count `failed` runs must be able to leave
 * it out. Thrown by the loop at the point it observed the cancel, and settled by the runner, which
 * records the run `cancelled` and ends the stream with a `cancelled` frame rather than failing it.
 *
 * Carries no message detail on purpose: there is nothing to diagnose, and a cancel reads the same
 * whether it came from a Stop button, an operator console, or a deployment draining.
 */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

/**
 * The stream error code a failed run surfaces to its subscriber. A refusal by an output processor
 * and an answer that never satisfied `outputSchema` are the CONTROLS working, not the model
 * breaking: a client that retries on `run_failed` must not retry either of them, and neither should
 * page whoever is on call for model failures.
 */
export function agentFailureCode(error: unknown): string {
  // A cancel is not a failure at all — both runners settle it on its own path and never reach here.
  // It is answered anyway so that a host which does route it through the failure machinery cannot
  // end up reporting a user's Stop as `run_failed`.
  if (error instanceof RunCancelledError) {
    return 'cancelled';
  }
  if (error instanceof QuotaExceededError) {
    return 'quota_exceeded';
  }
  if (error instanceof OutputRejectedError) {
    return 'output_rejected';
  }
  if (error instanceof StructuredOutputError) {
    return 'structured_output_invalid';
  }
  return 'run_failed';
}

/**
 * The default depth at which agent→agent delegation stops nesting, when the host names none.
 * Override with {@link AgentLoopDeps.maxDelegationDepth}.
 *
 * A backstop for a chain that is merely LONG. The cycle it used to stand in for is now detected
 * directly — see {@link DEFAULT_MAX_AGENT_APPEARANCES}.
 *
 * WHEN IT ACTUALLY BINDS. At one appearance per agent, a chain cannot be longer than the number of
 * registered agents, so a deployment with fewer agents than this number never reaches it: the cycle
 * guard always fires first. It starts mattering with a larger fleet of agents than the ceiling, or
 * once a host raises {@link AgentLoopDeps.maxAgentAppearances}, which is what lets a chain revisit
 * an agent and therefore grow past the fleet's size.
 */
export const MAX_DELEGATION_DEPTH = 5;

/**
 * How many times one agent may appear on a single delegation chain, when the host names no other
 * number. Once: a chain that reaches an agent it has already passed through is going in circles.
 *
 * Override with {@link AgentLoopDeps.maxAgentAppearances} — a supervisor that genuinely hands work
 * back to an earlier agent needs a larger number, and it is the count of APPEARANCES, so 2 admits
 * exactly one return.
 */
export const DEFAULT_MAX_AGENT_APPEARANCES = 1;

/**
 * Why this delegation must not happen, or `null` to let it through.
 *
 * Two different refusals, and the order matters: a CYCLE is named before a depth, because they
 * describe different faults and the depth is the vaguer of the two. "A→B→A" points at the wiring;
 * "depth limit of 5 reached" leaves a reader to work out whether the chain was looping or merely
 * long, which is exactly the question a count cannot answer.
 */
function delegationRefusal(args: {
  deps: Pick<AgentLoopDeps, 'maxAgentAppearances' | 'maxDelegationDepth'>;
  input: Pick<AgentRunInput, 'agentName' | 'delegationDepth' | 'delegationPath'>;
  targetAgent: string;
}): string | null {
  const { deps, input, targetAgent } = args;
  // `delegationPath` is the chain that REACHED this run, so it stops short of the agent running
  // now — a runner appends its own name only on the way into a child. Both the count and the named
  // chain want the hop being taken, so this run's agent joins the end of the ancestry: without it a
  // mutual handoff is refused as `alpha → alpha`, an edge no deployment declares, and an agent
  // delegating to ITSELF from a top-level turn is not caught at all until one hop later.
  const ancestry = [
    ...(input.delegationPath ?? []),
    ...(input.agentName !== undefined ? [input.agentName] : []),
  ];
  const appearances = ancestry.filter((name) => name === targetAgent).length;
  const maxAppearances = deps.maxAgentAppearances ?? DEFAULT_MAX_AGENT_APPEARANCES;
  if (appearances >= maxAppearances) {
    const chain = [...ancestry, targetAgent].join(' → ');
    const times = appearances + 1;
    return `(delegation cycle: ${chain} — ${targetAgent} ${times} times on one chain)`;
  }
  const maxDepth = deps.maxDelegationDepth ?? MAX_DELEGATION_DEPTH;
  if ((input.delegationDepth ?? 0) >= maxDepth) {
    return `(delegation depth limit of ${maxDepth} reached)`;
  }
  return null;
}

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
export function withToolTimeout<T>(work: Promise<T>, ms: number, toolName: string): Promise<T> {
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
 * Wrap a genuinely-executing operation in an `aviary:agent:<event>` span (the diagnostics
 * `trace()` API — five `:start`/`:end`/`:asyncStart`/`:asyncEnd`/`:error` sub-channels),
 * correlated to its run by `traceId = runId`, WITHOUT letting the operation's raw return value
 * ride the span envelope: `trace` publishes the traced fn's return as the span's `result`, so the
 * traced fn returns only `summarize`d metadata (token counts / lengths / names — never prompt or
 * output text, the point events' redaction posture) while the real value is handed back to the
 * caller through the closure. Zero-cost when no span sub-channel has a subscriber.
 *
 * REPLAY SAFETY: call sites MUST sit INSIDE a `hooks.step` body (or another genuinely-executed
 * path). Durable replay skips step bodies and returns checkpoints, which is exactly what keeps a
 * replayed run from re-emitting spans. Never wrap a `hooks.step(...)`/`hooks.dispatch*(...)`
 * CALL — those run (and resolve from cache) on every replay.
 */
async function spanned<TEvent extends AgentSpanEvent, T>(
  event: TEvent,
  runId: string,
  payload: PayloadOf<'agent', TEvent>,
  run: () => Promise<T>,
  summarize: (value: T) => Record<string, unknown>,
): Promise<T> {
  let value!: T;
  await trace(
    'agent',
    event,
    async () => {
      value = await run();
      return summarize(value);
    },
    payload,
    { traceId: runId },
  );
  return value;
}

/**
 * Span-wrap one model call (`aviary:agent:llm.turn`). Exported so the durable dispatched-step
 * handler (which executes the genuine remote llm step) can emit the same span — core cannot wrap
 * `hooks.dispatchLlm` itself, because that call also runs (from cache) on replay.
 */
export function traceLlmTurn(
  runId: string,
  step: number,
  run: () => Promise<ModelTurnResult>,
): Promise<ModelTurnResult> {
  return spanned('llm.turn', runId, { runId, step }, run, (turn) => ({
    ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    textLength: turn.text.length,
    toolCalls: turn.toolCalls.length,
  }));
}

/**
 * Span-wrap one tool invocation (`aviary:agent:tool.execution`). The tool's raw output never
 * rides the span (only the start payload's name/type metadata + duration). Exported for the
 * durable dispatched-step handler, like {@link traceLlmTurn}.
 */
export function traceToolExecution<T>(
  runId: string,
  call: { toolCallId: string; toolName: string; toolType: 'read' | 'action' },
  run: () => Promise<T>,
): Promise<T> {
  return spanned('tool.execution', runId, { runId, ...call }, run, () => ({}));
}

/** Everything a turn needs off its thread, with the history ceiling already applied. */
interface TurnHistory {
  /** What rides into the turn, oldest-first — already through {@link HistoryPolicy.select}. */
  messages: ModelMessage[];
  /**
   * What the ceiling left out. Carried ONLY where a summarizer is configured to fold them back in:
   * `history:summarize` can run in a later process than the one that loaded the thread, so the
   * journal is the only place it can read them from. Everywhere else they are exactly the half of
   * the transcript the ceiling exists to leave behind.
   */
  dropped: ModelMessage[];
  /** The thread's title, or `null` where the store has no such thread. */
  title: string | null;
  /** Does the thread already hold an assistant message? Decides a `thread-start` intake. */
  hasAssistantMessage: boolean;
}

/** The thread's stored rows as the model sees them — the store's own bookkeeping left behind. */
function toModelMessages(messages: StoredMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolResults !== undefined ? { toolResults: message.toolResults } : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
  }));
}

/** Whose history this is, as the policy's two halves both see it. */
function historyContext(input: AgentRunInput): HistoryPolicyContext {
  return {
    threadId: input.threadId,
    actor: input.actor,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
  };
}

/** The configured ceiling's split, or the whole transcript where no policy is configured. */
function splitHistory(
  policy: HistoryPolicy | undefined,
  input: AgentRunInput,
  messages: ModelMessage[],
): HistorySelection {
  return policy === undefined
    ? { keep: messages, drop: [] }
    : policy.select(messages, historyContext(input));
}

/**
 * Load the thread and journal the messages the turn is going to send.
 *
 * `select` runs INSIDE the checkpoint, so what the position holds is the ceiling's RESULT. It is
 * contractually pure and takes no position of its own. `hooks.step` checkpoints its body's output,
 * and a `ThreadDetail` is the store's entire transcript — every message row, its id and timestamp,
 * and every tool result the thread ever recorded — written to a JSON column once and then re-read
 * and re-parsed by every process that resumes the run. Recording the selection makes the bound the
 * model's prompt respects the bound that payload respects too.
 *
 * The title and the assistant-message flag ride along because they are the only other things the
 * turn reads off the thread, and re-reading the store for them would put the row back.
 */
async function loadSelectedHistory(
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): Promise<TurnHistory> {
  return hooks.step('load:thread', async (): Promise<TurnHistory> => {
    const thread = await readThreadForTurn(deps, input.threadId);
    const { keep, drop } = splitHistory(
      deps.historyPolicy,
      input,
      toModelMessages(thread.messages),
    );
    return {
      messages: keep,
      dropped: deps.historyPolicy?.summarize === undefined ? [] : drop,
      title: thread.title,
      hasAssistantMessage: thread.hasAssistantMessage,
    };
  });
}

/** The three things a turn reads off its thread, however the store was able to answer them. */
interface ThreadForTurn {
  /** Oldest-first, and at most what the ceiling was going to keep. */
  messages: StoredMessage[];
  title: string | null;
  hasAssistantMessage: boolean;
}

/**
 * Read the thread: the store's bounded WINDOW where it offers one, else its whole transcript.
 *
 * Probed structurally, the same seam as `defaultAgentForThread` — the window is an optimization a
 * store either offers or does not, and one that predates it still answers correctly through
 * `getThread`. Which branch runs is invisible to the journal on purpose: both produce the same three
 * answers, so the payload this checkpoint records is identical either way and a deployment's choice
 * of store can never decide a run's checkpoints. That is also why the probe lives INSIDE
 * `load:thread` rather than around it — it adds no position, and a replaying process reads the
 * recorded payload back without calling the store at all.
 *
 * `hasAssistantMessage` is taken from the page's own flag rather than scanned out of its messages,
 * because the page's flag answers over the whole thread. It decides a `thread-start` intake, and a
 * window that happens to hold only the user's last questions belongs to a conversation that has
 * still been answered — scanned off the window, such a thread re-introduces itself every turn.
 */
async function readThreadForTurn(deps: AgentLoopDeps, threadId: string): Promise<ThreadForTurn> {
  const windowing = deps.store as Partial<ThreadTurnReader>;
  if (typeof windowing.loadThreadForTurn === 'function') {
    const messageLimit = turnMessageLimit(deps.historyPolicy);
    const page = await windowing.loadThreadForTurn({
      threadId,
      ...(messageLimit !== undefined ? { messageLimit } : {}),
    });
    return page === null
      ? { messages: [], title: null, hasAssistantMessage: false }
      : {
          messages: page.messages,
          title: page.title,
          hasAssistantMessage: page.hasAssistantMessage,
        };
  }
  const thread = await deps.store.getThread(threadId);
  const stored = thread?.messages ?? [];
  return {
    messages: stored,
    title: thread?.title ?? null,
    hasAssistantMessage: stored.some((message) => message.role === 'assistant'),
  };
}

/**
 * How many of the thread's newest rows to ask the store for — the policy's own row ceiling, or
 * nothing at all, which asks for the transcript.
 *
 * A policy that SUMMARIZES gets no limit. `summarize` is handed what `select` dropped, and a read
 * bounded to what `select` keeps drops nothing: the turn would fold an empty summary into a prompt
 * that is missing the messages it stands in for, with no error anywhere.
 *
 * A ceiling expressed only in TOKENS gets no limit either, and none can be derived from it: one
 * message can be four tokens or forty thousand, so no row count follows from a token budget. Naming
 * one too low reads fewer rows than `select` would have kept, which changes the prompt itself;
 * leaving it out only costs the read. A policy that wants its bound to reach the database states
 * {@link HistoryPolicy.maxMessages} alongside the token budget.
 */
function turnMessageLimit(policy: HistoryPolicy | undefined): number | undefined {
  if (policy === undefined || policy.summarize !== undefined) {
    return undefined;
  }
  return policy.maxMessages;
}

/**
 * The load a run recorded before the selection moved inside the checkpoint has to keep replaying
 * against: the whole `ThreadDetail` journaled, the split taken outside it. Reachable only through
 * {@link SELECTED_HISTORY_PATCH} answering false, and deletable once no such run is still in flight.
 */
async function loadWholeThread(
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): Promise<TurnHistory> {
  const thread = await hooks.step('load:thread', () => deps.store.getThread(input.threadId));
  const stored = thread?.messages ?? [];
  const { keep, drop } = splitHistory(deps.historyPolicy, input, toModelMessages(stored));
  return {
    messages: keep,
    dropped: drop,
    title: thread?.title ?? null,
    hasAssistantMessage: stored.some((message) => message.role === 'assistant'),
  };
}

/**
 * Fold what the ceiling dropped into a leading `system` message the model reads in their place.
 *
 * Summarizing calls a model, so it is journaled under `history:summarize`: a resumed run reads back
 * the summary the suspended attempt produced instead of writing a different one into the prompt.
 * This checkpoint and the usage row below are reachable ONLY through a configured summarizer, so no
 * run that predates one can land on either.
 */
async function foldDroppedHistory(
  summarize: NonNullable<HistoryPolicy['summarize']>,
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
  history: TurnHistory,
): Promise<ModelMessage[]> {
  const summary = await hooks.step('history:summarize', () =>
    summarize(history.dropped, historyContext(input)),
  );
  if (summary.usage !== undefined) {
    const usage = summary.usage;
    await hooks.step('persist:usage:history', () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        modelId: summary.modelId ?? deps.modelId ?? 'unknown',
        purpose: 'history_summary',
        usage,
      }),
    );
  }
  return [{ role: 'system', content: buildSummaryBlock(summary.text) }, ...history.messages];
}

/** One turn's identity, as both processor chains see it. */
function processorContext(input: AgentRunInput, step: number): ProcessorContext {
  return {
    threadId: input.threadId,
    actor: input.actor,
    step,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
  };
}

/**
 * What the formatting pass is shown: the question, then the answer it has to restate.
 *
 * The question comes off the PROCESSED prompt rather than `AgentRunInput.userText`, because the pass
 * is a second route out of the model and has to stand behind the same input chain the streamed turn
 * did — a question a processor masked must not reappear in the clear here. Falls back to the answer
 * alone where the chain left no user message to point at.
 *
 * See {@link AgentLoopDeps.outputFromTranscript} for the agent that needs more than this, and why it
 * is the opt-in rather than the default.
 */
function restatementPrompt(
  messages: ModelMessage[],
  answer: string,
  fromTranscript: boolean,
): ModelMessage[] {
  const restated: ModelMessage = { role: 'assistant', content: answer };
  if (fromTranscript) {
    return [...messages, restated];
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return [message, restated];
    }
  }
  return [restated];
}

/** One attempt of the formatting pass: what the model replied, and what it cost. */
interface StructuredAttempt {
  text: string;
  object?: unknown;
  usage: MessageUsage;
  modelId?: string;
}

/**
 * Restate a finished answer as `deps.outputSchema`, repairing a rejected reply up to
 * `outputRepairAttempts` times. Every model call is its own checkpoint (`structured:<step>:<n>`)
 * with its own usage row, so a suspend between two attempts resumes on the reply the first one got
 * rather than paying for a third.
 *
 * Validation itself sits OUTSIDE the checkpoints, on the same footing as `HistoryPolicy.select`: its
 * inputs are the schema (module config, identical on every process of a deployment) and the reply
 * a checkpoint already holds, so every replay reaches the same verdict — and therefore the same
 * number of attempts — without a checkpoint of its own.
 *
 * THE OUTPUT CHAIN RULES ON EACH ATTEMPT, before the schema does. This pass is a second route out of
 * the model: it is handed the finished answer and asked to restate it, so anything the chain held
 * back from the prose can be restated into the schema and leave through here. It is gated on the
 * WHOLE reply regardless of what the chain declared, because nothing here is streamed — there is no
 * prefix for an `incremental` processor to release, and the release path it buys does not exist.
 */
async function structureAnswer<TOutput>(
  schema: StandardSchemaV1<unknown, TOutput>,
  deps: AgentLoopDeps<TOutput>,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
  messages: ModelMessage[],
  step: number,
): Promise<TOutput> {
  const instruction = deps.outputInstruction ?? DEFAULT_STRUCTURED_OUTPUT_INSTRUCTION;
  const maxAttempts = 1 + (deps.outputRepairAttempts ?? 1);
  const outputProcessors = deps.outputProcessors ?? [];
  let issues: readonly StandardSchemaV1.Issue[] = [];
  let text = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const system = attempt === 0 ? instruction : repairInstruction(instruction, issues);
    const reply = await hooks.step(`structured:${step}:${attempt}`, () =>
      spanned(
        'structured-output',
        hooks.runId,
        { runId: hooks.runId, step, attempt },
        async (): Promise<StructuredAttempt> => {
          const discard: SinkWriter = { write: () => {}, end: () => {}, fail: () => {} };
          const turn = await deps.model.runTurn({
            system,
            messages,
            tools: [],
            sink: discard,
            outputSchema: schema,
          });
          return {
            text: turn.text,
            usage: turn.usage,
            ...(turn.object !== undefined ? { object: turn.object } : {}),
            ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
          };
        },
        (result) => ({
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          textLength: result.text.length,
        }),
      ),
    );
    await hooks.step(`persist:usage:structured:${step}:${attempt}`, () =>
      deps.store.recordUsage({
        threadId: input.threadId,
        actorRef: input.actor.id,
        modelId: reply.modelId ?? deps.modelId ?? 'unknown',
        purpose: 'structured_output',
        usage: reply.usage,
      }),
    );
    text = reply.text;
    if (outputProcessors.length > 0) {
      // Its own checkpoint, after the usage row: the tokens were spent either way, and a refusal
      // that also hid its own cost would let a mis-tuned gate burn a budget invisibly — the same
      // ordering the streamed answer's gate takes.
      const gate = await hooks.step(`process:output:structured:${step}:${attempt}`, () =>
        runOutputProcessors(
          outputProcessors,
          { text: reply.text, toolCalls: [] },
          processorContext(input, step),
        ),
      );
      if (gate.rejection !== undefined) {
        throw new OutputRejectedError(gate.rejection.processor, gate.rejection.reason);
      }
      text = gate.text;
    }
    // A provider that constrained its own generation reports a parsed `object`, but that object
    // describes the reply the chain has just rewritten. Once the two disagree, the gated text is the
    // only version anything downstream may see, so it is re-parsed rather than trusted.
    const reported = text === reply.text ? reply.object : undefined;
    const outcome = await validateStructured(schema, text, reported);
    if (outcome.ok) {
      return outcome.value;
    }
    issues = outcome.issues;
  }
  throw new StructuredOutputError(issues, text, maxAttempts);
}

/**
 * What resolving a call's kind needs: the registry, plus the three config flags whose reserved names
 * have no `ToolSpec` to look up. Narrow on purpose — {@link stampToolKinds} is called from a
 * dispatched step handler, which holds the host's own deps rather than a loop's.
 */
export type ToolKindDeps = Pick<AgentLoopDeps, 'registry' | 'ask' | 'skills' | 'memory'>;

/**
 * Stamp each of a model turn's calls with the kind declared WHERE THE TOOL WAS OFFERED.
 *
 * A call exists only because some process put that tool's definition in front of the model, so that
 * process is the one that certainly knows the tool. Another process might not: a deployment that
 * splits its pods by role has one that serves HTTP and replays run bodies without registering the
 * tool classes, and its registry answers `undefined`. Stamping here, INSIDE the llm checkpoint, is
 * what puts the kind in the journal — so the branch a call takes is a fact about the turn rather
 * than about whichever process happened to replay it (see {@link claimToolCall}).
 *
 * Only unstamped calls are touched: a kind already on a call was settled upstream, and a process
 * further down never second-guesses it.
 */
export function stampToolKinds<T extends { toolCalls: ToolCallRequest[] }>(
  result: T,
  deps: ToolKindDeps,
): T {
  return {
    ...result,
    toolCalls: result.toolCalls.map((call) =>
      call.kind === undefined ? { ...call, kind: declaredKind(deps, call.name) } : call,
    ),
  };
}

/**
 * A call's declared kind, as settled inside `persist:toolcall` and journaled from there.
 *
 * The reserved `ask` name resolves from module CONFIG, never from the registry: `ask` has no handler
 * to register, and grounding its branch in config is what keeps a process with a partial registry
 * from disagreeing about it — the same property the registry lookup below has only because its
 * answer is written into the journal. Every other name is the registry's `ToolSpec`, exactly as
 * before.
 */
function declaredKind(deps: ToolKindDeps, name: string): ToolKind {
  if (deps.ask === true && name === ASK_TOOL_NAME) {
    return 'ask';
  }
  // Same reserved-name reasoning as `ask`: `skill` has no handler either, and it is the JOURNALED
  // value below — not this config — that every replay reads the branch back from.
  if (deps.skills !== undefined && name === SKILL_TOOL_NAME) {
    return 'skill';
  }
  if (memoryIsWritable(deps) && name === REMEMBER_TOOL_NAME) {
    return 'memory';
  }
  return deps.registry.spec(name)?.kind ?? 'read';
}

/**
 * Does this deployment offer the `remember` tool at all? Memory a host serves read-only (a provider
 * with no `write`) still writes its block into the prompt and still spends `memory:digest`, but the
 * model is never shown a tool it would only be refused by. Module config either way, so the worker
 * re-deriving a dispatched turn's tool list reaches the same answer as the loop.
 */
function memoryIsWritable(deps: Pick<AgentLoopDeps, 'memory'>): boolean {
  return deps.memory?.provider.write !== undefined;
}

/**
 * Append the built-in `ask` definition to a turn's tool list. Exported because the dispatched llm
 * step re-derives the tool list on a worker and has to reach the same list the loop would have.
 */
export function withAskTool({
  tools,
  ask,
}: { tools: ToolDefinition[]; ask: boolean | undefined }): ToolDefinition[] {
  return ask === true ? [...tools, askToolDefinition()] : tools;
}

/**
 * Park on a question set, through whichever wait the host implemented, and read back whatever that
 * wait delivered as answers.
 *
 * The reduction of a yes/no channel — approve is "confirmed the pre-picked answers", reject is
 * "skipped" — applies to BOTH branches, because the shape of the reply is decided by whoever settled
 * the tool call, not by which hook the host wired. The question set sits in the approvals inbox as a
 * `pending_approval` action, so an operator pressing Approve there sends a `Decision` into a run
 * whose host implements `awaitAnswers` perfectly well. See {@link normalizeElicitationReply}.
 *
 * Neither branch moves a checkpoint: the wait sits at the same position either way, so the choice of
 * hook cannot change the sequence a replay lines up with.
 */
async function awaitElicitation(
  hooks: AgentLoopHooks,
  request: ElicitationRequest,
  ctx: AiToolCtx,
): Promise<ElicitationReply> {
  if (hooks.awaitAnswers !== undefined) {
    return normalizeElicitationReply(await hooks.awaitAnswers(request, ctx));
  }
  return normalizeElicitationReply(
    await hooks.awaitApproval(
      { id: request.id, name: ASK_TOOL_NAME, input: request, kind: 'ask' },
      ctx,
    ),
  );
}

/** The tool context a turn hands to a handler — and to the wait an elicitation parks on. */
function toolContext(deps: AgentLoopDeps, input: AgentRunInput, hooks: AgentLoopHooks): AiToolCtx {
  return {
    actor: input.actor,
    threadId: input.threadId,
    runId: hooks.runId,
    requestId: hooks.runId,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
    ...(deps.host !== undefined ? { host: deps.host } : {}),
  };
}

/**
 * Does the configured intake run this turn? Both inputs are facts the journal already holds — the
 * config, and `load:thread`'s record of whether the thread had an assistant message when the turn
 * began. Neither is re-read from the store here, and that is the point: by the time a replay reaches
 * this line the first attempt has already appended the intake's own assistant message to the thread,
 * so a fresh read would answer differently on the resume than it did on the way in, and the answer
 * decides how many checkpoints follow it.
 */
function intakeApplies(intake: AgentIntake, threadHasAssistant: boolean): boolean {
  return intake.when === 'every-turn' || !threadHasAssistant;
}

/**
 * The configured intake: post the authored question set, park until a human settles it, and leave
 * the exchange on the transcript as an ordinary tool round-trip so the model reads the answers the
 * same way it reads its own `ask`'s.
 *
 * COSTS NO MODEL CALL. The questions, their options and their pre-picked defaults are all authored
 * on the `@Agent`, so nothing here is generated and nothing here is billed — which is also why the
 * total is knowable before the first question is shown.
 *
 * One checkpoint whenever an `intake` is configured, plus two more on the turns it actually asks —
 * all of them reachable only through that config, so a run that predates the option cannot land on
 * any of them and no marker is spent keeping the sequence stable for it. See
 * {@link AgentLoopHooks.patched} for the case that does need one.
 */
async function runIntake(
  intake: AgentIntake,
  deps: AgentLoopDeps,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
  writer: SinkWriter,
  threadHasAssistant: boolean,
): Promise<ModelMessage | null> {
  const preamble = intake.preamble ?? DEFAULT_INTAKE_PREAMBLE;
  // Derived from the run, so a replay rebuilds the same id without minting one — the id is a
  // checkpoint name's suffix and the signal's own key, so it cannot come from a random source.
  const request: ElicitationRequest = {
    id: `intake-${hooks.runId}`,
    source: 'intake',
    preamble,
    questions: intake.questions,
  };
  const call: ToolCallRequest = {
    id: request.id,
    name: ASK_TOOL_NAME,
    input: { preamble, questions: intake.questions },
    kind: 'ask',
  };
  // The message id rides the checkpoint because the answers land on the SAME message the questions
  // did, and the step that settles them runs after a wait that can outlive the process.
  const asked = await hooks.step('intake:ask', async (): Promise<{ messageId: string } | null> => {
    if (!intakeApplies(intake, threadHasAssistant)) {
      return null;
    }
    const message = await deps.store.appendMessage({
      threadId: input.threadId,
      role: 'assistant',
      content: preamble,
      runId: hooks.runId,
      toolCalls: [call],
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    });
    await deps.store.recordToolCall({
      toolCallId: request.id,
      messageId: message.id,
      toolName: ASK_TOOL_NAME,
      // The store knows read/action only. An unanswered question is work waiting on a human, which
      // is what `action` + `pending_approval` already mean — so it surfaces in an approvals inbox
      // rather than needing one of its own.
      toolType: 'action',
      input: call.input,
      status: 'pending_approval',
      runId: hooks.runId,
    });
    await writer.write(encodeStreamEvent({ kind: 'elicitation', id: request.id, request }));
    return { messageId: message.id };
  });
  if (asked === null) {
    return null;
  }
  const messageId = asked.messageId;
  const reply = await awaitElicitation(hooks, request, toolContext(deps, input, hooks));
  const result = settleElicitation(request, reply);
  await hooks.step('intake:answers', async () => {
    await deps.store.updateToolCall({
      toolCallId: request.id,
      // A skip is not an answer. Both leave the agent holding the same values, but only one of them
      // is evidence the user chose them, and a reader auditing what the agent was told has to be
      // able to tell those apart.
      status: result.skipped ? 'rejected' : 'executed',
      output: result,
      ...(result.skipped ? { error: 'skipped by the user' } : {}),
      ...(reply.answeredByRef !== undefined ? { executedByRef: reply.answeredByRef } : {}),
    });
    await deps.store.setMessageToolResults(messageId, [
      { id: request.id, name: ASK_TOOL_NAME, output: result },
    ]);
    await writer.write(encodeStreamEvent({ kind: 'tool-output', id: request.id, output: result }));
  });
  return {
    role: 'assistant',
    content: preamble,
    toolCalls: [call],
    toolResults: [{ id: request.id, name: ASK_TOOL_NAME, output: result }],
  };
}

/**
 * Identifies the batched tool-call shape to {@link AgentLoopHooks.patched}. Batching hoists the
 * turn's `persist:toolcall` checkpoints ahead of its first tool execution, so a run that suspended
 * mid-turn under the one-call-at-a-time shape must keep replaying against THAT one.
 */
const PARALLEL_TOOLS_PATCH = 'agent:parallel-tools';

/**
 * Identifies the cancellable loop shape to {@link AgentLoopHooks.patched}. The observation points it
 * guards are new positions in the middle of the sequence, so a run that suspended before a
 * deployment gained them must keep replaying against the sequence its history holds.
 */
const CANCELLATION_PATCH = 'agent:cancellation';

/**
 * Identifies the selected-history load to {@link AgentLoopHooks.patched}. `load:thread` keeps its
 * name and its position; what changed is what it CHECKPOINTS — the messages the turn will send
 * rather than the whole `ThreadDetail` — and a checkpoint's payload is a wire contract with every
 * run already in flight just as its name is.
 *
 * A marker rather than a tolerance for the old payload, because the two shapes cannot be told apart
 * where it matters: both carry `messages` and a `title`, and an empty thread serializes to something
 * either release could have written. The marker is a fact the JOURNAL holds, at a position the
 * runtime hands back to a run that recorded a real step there, so the branch is decided by the run's
 * own history rather than by a guess at its bytes. What rides on getting it right is
 * `history:summarize`: its presence depends on a split the old payload carries no record of, so a
 * resume that read that payload as the new shape would skip a position the history has spent.
 */
const SELECTED_HISTORY_PATCH = 'agent:selected-history';

/**
 * Identifies the JOURNALED prompt-stage set to {@link AgentLoopHooks.patched} — the marker that lets
 * {@link PromptStages} be read back from a run's own history instead of re-derived from whatever
 * module config the process replaying it happens to hold.
 *
 * WHERE IT SITS, and why the choice is narrow. Probed after the history load and immediately before
 * `run:started-at`. The position has to be one that every journal written before this marker existed
 * fills with a REAL step whatever it was configured with — because `patched` refuses, raising
 * `NonDeterminismError` rather than rewinding, when it finds a DIFFERENT `patch:` marker where it
 * looks. That rules out the position after `persist:user`, which holds `agent:selected-history`, and
 * the position after `persist:run:start`, which holds `agent:cancellation` on a deployment that
 * enables none of the three stages. `load:thread`, `run:started-at` and `persist:run:start` are the
 * unconditional steps in between, and this marker takes the gap before the second of them.
 *
 * WHY NOT A MARKER PER STAGE, guarding each stage's own position. Because a stage's position is
 * already occupied on every deployment that has the stage switched on: a journal written with memory
 * enabled holds `memory:digest` exactly where that marker would sit, `patched` rewinds and answers
 * false there, and the guard would then SKIP a checkpoint the history holds — diverging a few
 * positions later, on every in-flight run of every host already using the feature. That is the
 * opposite of the protection it was reached for. `agent:dispatched-steps` can be guarded that way
 * only because no journal anywhere holds the shape it guards without also holding the marker.
 * Journals DO hold `memory:digest`, `retrieve` and `skills:catalog` with no marker in front of them.
 *
 * So the marker records a property of the BODY — "this run journals which prompt stages it had" —
 * and the per-stage answers ride in the checkpoint below, where three independent switches are
 * stated separately instead of one boolean standing in for all of them.
 */
const PROMPT_STAGES_PATCH = 'agent:prompt-stages';

/**
 * Which of the three optional prompt stages this RUN had. Each spends a checkpoint position that
 * exists only where a host wired the matching dep, so together they decide the turn's checkpoint
 * SEQUENCE:
 *
 * - `memory` → `memory:digest`
 * - `retriever` → `retrieve`
 * - `skills` → `skills:catalog`
 *
 * Read from module config ONCE, at {@link PROMPT_STAGES_PATCH}'s position, and journaled there.
 * Every later replay reads those three answers back — so enabling memory on a deployment cannot
 * insert a position into a run that is parked on a human's approval, and disabling it cannot take
 * one away.
 *
 * WHAT IT DOES NOT COVER, because the next reader should not have to assume. `quota` is the one
 * stage of this kind that CANNOT be guarded this way: `quota:check` is the loop's first position, so
 * the only marker position that precedes it is the workflow's own first, which
 * `agent:dispatched-steps` already owns — and a second marker there would make that guard raise
 * instead of rewind. Enabling a quota store under a parked run therefore still shifts its sequence.
 * `pricingStore` (`pricing:list`), `intake` (`intake:ask`/`intake:answers`), `inputProcessors`
 * (`process:input:<step>`), `outputProcessors` (`process:output:<step>` and the follow-ups gate),
 * `followUpsCount` (`followups:<step>` and its usage row) and `outputSchema` (`structured:*`) all
 * sit after this marker and so COULD join this payload; they do not yet. A field added here for one
 * of them reads back `undefined` on a run journaled before it, which has to mean "fall back to
 * config" — that run's exposure unchanged rather than inverted.
 *
 * WHAT STAYS MODULE CONFIG, deliberately: the turn's TOOL LIST. Whether the model is offered `skill`
 * or `remember` is uniform across a deployment and is re-derived on whichever worker serves a
 * dispatched model call, and the `skill`/`remember` handlers already answer a call they have no
 * catalog or digest for as a tool failure. Only positions are journaled here.
 */
interface PromptStages {
  memory: boolean;
  retriever: boolean;
  skills: boolean;
}

/**
 * The prompt stages this run is held to: the journal's record of them, or — for a run whose journal
 * predates {@link PROMPT_STAGES_PATCH} — the live configuration, which is what that run's own body
 * used.
 */
async function resolvePromptStages(
  deps: AgentLoopDeps,
  hooks: AgentLoopHooks,
): Promise<PromptStages> {
  const configured: PromptStages = {
    memory: deps.memory !== undefined,
    retriever: deps.retriever !== undefined,
    skills: deps.skills !== undefined,
  };
  return (await (hooks.patched?.(PROMPT_STAGES_PATCH) ?? Promise.resolve(true)))
    ? hooks.step('run:prompt-stages', () => Promise.resolve(configured))
    : configured;
}

// What a stage answers where the RUN recorded it but this process has nothing wired to serve it —
// the mid-rollout case of a dep taken away under a run that is still in flight.
//
// Reachable only on the attempt that first ARRIVES at the position: a replay is served the journaled
// payload without running the body at all. So what it costs is one run's worth of the stage
// degrading to nothing, in exchange for the position staying where the history put it — the same
// posture the `skill` and `remember` handlers take when their config has gone.
const UNSERVED_MEMORY: MemoryDigest = { scopes: [], entries: [], omitted: 0, pinnedOmitted: 0 };
const UNSERVED_SKILLS: SkillOffer = { scopes: [], entries: [], omitted: 0 };

/**
 * Read the cancel flag at one of the loop's safe points, and unwind the turn if it is set.
 *
 * The read is a checkpoint, which is the whole design: the answer becomes a fact the journal holds
 * rather than one each replaying process asks afresh — see {@link AgentLoopHooks.cancelled}. Unwinds
 * by THROWING, the same way a suspend leaves the turn, so every `catch` between here and the runner
 * already knows to let it past without writing checkpoints of its own.
 *
 * A tool that is already executing is NOT interrupted. There is no un-executing a side effect, and
 * abandoning a dispatched step mid-flight would leave the journal holding a dispatch whose result
 * never lands — so an in-flight call finishes, is recorded exactly as it would have been, and the
 * cancel is observed at the next point instead.
 */
async function haltIfCancelled(
  hooks: AgentLoopHooks,
  cancellable: boolean,
  name: string,
): Promise<void> {
  const observe = hooks.cancelled;
  if (!cancellable || observe === undefined) {
    return;
  }
  if (await hooks.step(name, () => observe())) {
    throw new RunCancelledError();
  }
}

/** What every per-call helper below needs from the turn that requested the call. */
interface ToolTurnContext {
  deps: AgentLoopDeps;
  input: AgentRunInput;
  hooks: AgentLoopHooks;
  /** The assistant message the calls hang off. */
  messageId: string;
  /** The run's live stream — an `ask` posts its question set here while the turn parks. */
  writer: SinkWriter;
  /**
   * What `skills:catalog` recorded this turn, or undefined where skills are not configured. A
   * `skill` call is served against THIS, never against a fresh provider read — see {@link loadSkill}.
   */
  skills?: SkillOffer;
  /**
   * What `memory:digest` recorded this turn, or undefined where memory is not configured. A
   * `remember` call is authorized against THIS digest's scopes, never a fresh resolution — see
   * {@link writeMemory}.
   */
  memory?: MemoryDigest;
}

/** A tool call whose kind has been settled by its `persist:toolcall` checkpoint. */
interface ClaimedToolCall {
  /** The call as the model asked for it. */
  call: ToolCallRequest;
  /** The same call with `kind` agreeing with the branch actually taken. */
  resolvedCall: ToolCallRequest;
  toolType: ToolKind;
  targetAgent?: string;
  /** For an `agent` call — whether the journal says this delegation runs detached. */
  detached?: boolean;
  ctx: AiToolCtx;
}

/** One invocation's result, already reduced to what the persist checkpoint writes. */
type ToolOutcome =
  | { status: 'executed'; output: unknown; executionMs: number }
  | { status: 'failed'; error: string; executionMs: number };

/**
 * Record the call and settle its KIND, which decides this call's control flow: an `action` suspends
 * the run on an approval signal (`signal:tool:<runId>:<callId>`), anything else records a step.
 * Reading it from `deps.registry` in the loop body would tie that branch to the registry of
 * WHICHEVER PROCESS runs the body — and a process whose registry lacks this tool reads `undefined`,
 * falls back to 'read', and expects a `tool:` checkpoint where the history holds `signal:tool:`.
 * That is a NonDeterminismError on resume, and worse, when execution is dispatched
 * (`hooks.dispatchTool`) it reaches a worker that DOES have the tool: an action executed with
 * nobody's approval.
 *
 * Two things keep that from happening, and they answer different halves of it:
 *
 *   - The kind is RETURNED from the `persist:toolcall` step, so every replay reads back the same
 *     verdict instead of asking its own registry. That makes the decision CONSISTENT.
 *   - The kind it writes is the one {@link stampToolKinds} put on the call inside the llm
 *     checkpoint, where the tool was offered. That makes the decision CORRECT — the step is not
 *     necessarily first reached by a process that knows the tool. A dispatched turn resumes on
 *     whichever instance consumes the model step's result, and settling an approval resumes it on
 *     whichever instance took the decision; neither is chosen by role. A pod that registers no
 *     tool classes reached this step and journaled `read` for an action tool, intermittently,
 *     depending on which pod won that race.
 *
 * The local lookup remains as the fallback for a call that arrives unstamped: a journal written
 * before kinds travelled, or a host driving the loop with no llm checkpoint of its own. Same step
 * name at the same position throughout, so runs already in flight keep replaying.
 */
async function claimToolCall(
  turn: ToolTurnContext,
  call: ToolCallRequest,
): Promise<ClaimedToolCall> {
  const { deps, input, hooks, messageId } = turn;
  const persisted = (await hooks.step(`persist:toolcall:${call.id}`, async () => {
    const spec = deps.registry.spec(call.name);
    const kind: ToolKind = call.kind ?? declaredKind(deps, call.name);
    // Both kinds that park the turn on a person. The store knows read/action only; a delegation is
    // neither approved nor rejected by a human, so it persists as a read.
    const awaitsHuman = kind === 'action' || kind === 'ask';
    await deps.store.recordToolCall({
      toolCallId: call.id,
      messageId,
      toolName: call.name,
      toolType: awaitsHuman ? 'action' : 'read',
      input: call.input,
      status: awaitsHuman ? 'pending_approval' : 'auto_executed',
      runId: hooks.runId,
    });
    return {
      kind,
      ...(spec?.targetAgent !== undefined ? { targetAgent: spec.targetAgent } : {}),
      // Only an `agent` spec ever carries this, and only when the author declared it — so a
      // deployment with no detached edge writes the same bytes here it always has.
      ...(spec?.detached === true ? { detached: true } : {}),
    };
  })) as { kind?: ToolKind; targetAgent?: string; detached?: boolean } | undefined;
  const toolType: ToolKind = persisted?.kind ?? call.kind ?? 'read';
  return {
    call,
    // What the rest of the turn — the dispatched tool envelope, the stream frames — sees as this
    // call's kind, so it agrees with the branch actually taken instead of with a second lookup.
    resolvedCall: call.kind === toolType ? call : { ...call, kind: toolType },
    toolType,
    ...(persisted?.targetAgent !== undefined ? { targetAgent: persisted.targetAgent } : {}),
    ...(persisted?.detached === true ? { detached: true } : {}),
    ctx: toolContext(deps, input, hooks),
  };
}

/** What a served `skill` call hands back to the model — the procedure, and where it came from. */
interface LoadedSkillOutput {
  name: string;
  scope: string;
  body: string;
  /** Scopes of same-named skills this one overrode. Present only when it overrode something. */
  shadows?: string[];
}

/**
 * Serve one `skill` call: read the body and hand it to the model as an ordinary tool result.
 *
 * WHY THE BODY IS RETURNED FROM THE CHECKPOINT. Which instructions entered a turn's prompt is a
 * decision about the turn, and a decision about a turn has to be readable from its journal — the
 * same property `persist:toolcall` gives the read/action branch. A replay that re-read the provider
 * would compose a DIFFERENT prompt from a skill edited in between, on a transcript position the
 * history already holds: the model would then be answering something nobody can reconstruct from the
 * record, and a turn whose step count depends on what it was told would ask for a position its
 * history has no room for. Inside `tool:<callId>` the first attempt's text is the only text there
 * ever was.
 *
 * The positions are a read tool's, exactly (`persist:toolcall` above, `tool:<id>` here,
 * `persist:toolexec:<id>`/`persist:toolfail:<id>` after), so nothing about the shape of a turn
 * depends on whether a call was a skill — only on the kind the journal recorded.
 */
async function loadSkillIntoTurn(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
  startedAt: number,
): Promise<ToolOutcome> {
  const { deps, input, hooks } = turn;
  const { call } = claimed;
  const config = deps.skills;
  const offer = turn.skills;
  const outcome = await hooks.step(
    `tool:${call.id}`,
    async (): Promise<{ ok: true; output: LoadedSkillOutput } | { ok: false; error: string }> => {
      if (config === undefined || offer === undefined) {
        // Reachable only where a call's journaled kind is `skill` but this process has no skills
        // configured — a deployment mid-rollout. A tool failure, because it is the one vocabulary
        // the model can act on, and because failing the run would strand a turn over a lookup.
        return { ok: false, error: 'Skills are not available in this deployment.' };
      }
      const parsed = await skillInputSchema['~standard'].validate(call.input);
      if (parsed.issues !== undefined) {
        return {
          ok: false,
          error: `invalid skill input: ${parsed.issues.map((each) => `${(each.path ?? []).join('.') || '(root)'}: ${each.message}`).join('; ')}`,
        };
      }
      const loaded = await loadSkill(config, offer, parsed.value.name, skillContext(input));
      if (!loaded.ok) {
        return { ok: false, error: loaded.error };
      }
      return {
        ok: true,
        output: {
          name: loaded.skill.name,
          scope: loaded.skill.scope,
          body: loaded.skill.body,
          ...(loaded.shadows !== undefined ? { shadows: loaded.shadows } : {}),
        },
      };
    },
  );
  return outcome.ok
    ? { status: 'executed', output: outcome.output, executionMs: Date.now() - startedAt }
    : { status: 'failed', error: outcome.error, executionMs: Date.now() - startedAt };
}

/**
 * Serve one `remember` call: write the fact and hand the stored record back as an ordinary tool
 * result.
 *
 * WHY THE WRITE HAPPENS INSIDE THE CHECKPOINT. Two reasons, and the second is the one that is easy
 * to miss. It makes the write idempotent under replay — a resumed run reads the record back from
 * `tool:<callId>` instead of storing a second copy of a fact the model only decided once. And it
 * makes what the model was TOLD about the write part of the journal, so the transcript a later step
 * reads is the one the first attempt built, rather than whatever a second write would have returned.
 *
 * The positions are a read tool's, exactly, so nothing about the shape of a turn depends on whether
 * a call wrote a memory — only on the kind the journal recorded.
 */
async function rememberIntoTurn(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
  startedAt: number,
): Promise<ToolOutcome> {
  const { deps, input, hooks } = turn;
  const { call } = claimed;
  const config = deps.memory;
  const digest = turn.memory;
  const outcome = await hooks.step(
    `tool:${call.id}`,
    async (): Promise<{ ok: true; record: MemoryRecord } | { ok: false; error: string }> => {
      if (config === undefined || digest === undefined) {
        // Reachable only where a call's journaled kind is `memory` but this process has none
        // configured — a deployment mid-rollout. A tool failure, because it is the one vocabulary
        // the model can act on, and because failing the run would strand a turn over a lookup.
        return { ok: false, error: 'Memory is not available in this deployment.' };
      }
      const parsed = await rememberInputSchema['~standard'].validate(call.input);
      if (parsed.issues !== undefined) {
        return {
          ok: false,
          error: `invalid remember input: ${parsed.issues.map((each) => `${(each.path ?? []).join('.') || '(root)'}: ${each.message}`).join('; ')}`,
        };
      }
      return await writeMemory({
        config,
        digest,
        call: parsed.value,
        ctx: skillContext(input),
        runId: hooks.runId,
      });
    },
  );
  if (!outcome.ok) {
    return { status: 'failed', error: outcome.error, executionMs: Date.now() - startedAt };
  }
  publishAgentMemoryWritten({
    runId: hooks.runId,
    scope: outcome.record.scope,
    chars: outcome.record.text.length,
  });
  return { status: 'executed', output: outcome.record, executionMs: Date.now() - startedAt };
}

/** The turn's identity as the skills seam sees it — the same inputs the prompt is resolved from. */
function skillContext(input: AgentRunInput): SkillContext {
  return {
    actor: input.actor,
    threadId: input.threadId,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
  };
}

/**
 * Execute one claimed call. Requests its checkpoint SYNCHRONOUSLY (nothing is awaited before
 * `hooks.dispatchTool`/`hooks.step`), which is what lets a batch of these be launched together and
 * still occupy positions in call order — see {@link AgentLoopHooks.parallel}.
 *
 * A tool's own failure is an outcome, not a throw: the model gets it as a result and adapts. Only
 * the runner's control flow (a durable suspend / continue-as-new) and a replay-integrity refusal
 * escape — a `catch` that answered either of those by writing a `persist:toolfail` checkpoint would
 * diverge from the replay's real result, or ask for a position a diverged history has no room for
 * so the operator reads the second refusal instead of the disagreement that caused it.
 */
async function invokeClaimedTool(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolOutcome> {
  const { deps, input, hooks } = turn;
  const { call, resolvedCall, ctx } = claimed;
  // An `agent` call branches to delegation before reaching here, so anything that isn't an `action`
  // is a read — the same posture the kind fallback itself takes.
  const toolType = claimed.toolType === 'action' ? 'action' : 'read';
  const startedAt = Date.now();
  try {
    // Inside the same `try` as a registered tool's invocation, so a provider that throws is recorded
    // as this call's failure — and a suspend or a replay refusal still leaves untouched below.
    if (claimed.toolType === 'skill') {
      return await loadSkillIntoTurn(turn, claimed, startedAt);
    }
    if (claimed.toolType === 'memory') {
      return await rememberIntoTurn(turn, claimed, startedAt);
    }
    let output: unknown;
    if (hooks.dispatchTool) {
      const stepCtx: ToolStepCtx = {
        actor: input.actor,
        threadId: input.threadId,
        runId: hooks.runId,
        requestId: hooks.runId,
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      };
      const envelope: ToolStepEnvelope = {
        toolName: call.name,
        input: call.input,
        ctx: stepCtx,
        ...(deps.toolTimeoutMs !== undefined ? { timeoutMs: deps.toolTimeoutMs } : {}),
        // Numeric-only: the handler applies withToolTimeout AND its own local `classify` — see
        // ToolStepEnvelope.transientRetry.
        transientRetry: resolveToolTransientRetryNumbers(deps.toolTransientRetry),
      };
      // The handler applies withToolTimeout (and the retry loop) itself — no loop-side wrap for
      // a dispatched call.
      output = await hooks.dispatchTool(resolvedCall, envelope);
    } else {
      const invocation = hooks.step(`tool:${call.id}`, () =>
        traceToolExecution(
          hooks.runId,
          { toolCallId: call.id, toolName: call.name, toolType },
          () =>
            invokeWithTransientRetry(
              () => deps.registry.invoke(call.name, call.input, ctx, deps.rolesPolicy),
              deps.toolTransientRetry ?? {},
              {
                ...(hooks.isControlFlowError !== undefined
                  ? { isControlFlowError: hooks.isControlFlowError }
                  : {}),
                onRetry: (attempt, retryError) => {
                  publishAgentToolRetry({
                    toolName: call.name,
                    toolCallId: call.id,
                    attempt,
                    message: retryError instanceof Error ? retryError.message : String(retryError),
                  });
                },
              },
            ),
        ),
      );
      output =
        deps.toolTimeoutMs !== undefined
          ? await withToolTimeout(invocation, deps.toolTimeoutMs, call.name)
          : await invocation;
    }
    return { status: 'executed', output, executionMs: Date.now() - startedAt };
  } catch (error) {
    if (
      hooks.isControlFlowError?.(error) === true ||
      isControlFlowSignal(error) ||
      isReplayIntegrityError(error)
    ) {
      throw error;
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      executionMs: Date.now() - startedAt,
    };
  }
}

/** Persist one settled invocation and shape the result the model is fed. */
async function recordToolOutcome(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
  outcome: ToolOutcome,
  deciderRef: string,
): Promise<ToolResult> {
  const { deps, hooks } = turn;
  const { call } = claimed;
  const toolType = claimed.toolType === 'action' ? 'action' : 'read';
  if (outcome.status === 'failed') {
    await hooks.step(`persist:toolfail:${call.id}`, () =>
      deps.store.updateToolCall({
        toolCallId: call.id,
        status: 'failed',
        error: outcome.error,
        executionMs: outcome.executionMs,
      }),
    );
    publishAgentToolCall({
      runId: hooks.runId,
      toolName: call.name,
      toolType,
      status: 'failed',
      durationMs: outcome.executionMs,
    });
    return { id: call.id, name: call.name, output: null, error: outcome.error };
  }
  await hooks.step(`persist:toolexec:${call.id}`, () =>
    deps.store.updateToolCall({
      toolCallId: call.id,
      status: 'executed',
      output: outcome.output,
      executionMs: outcome.executionMs,
      ...(toolType === 'action' ? { executedByRef: deciderRef } : {}),
    }),
  );
  publishAgentToolCall({
    runId: hooks.runId,
    toolName: call.name,
    toolType,
    status: 'executed',
    durationMs: outcome.executionMs,
  });
  return { id: call.id, name: call.name, output: outcome.output };
}

/**
 * Delegate to another agent (an `agent`-kind call) and record what came back as this call's output:
 * the delegate's ANSWER when the turn waited for it, a {@link DetachedDelegationReceipt} when it did
 * not.
 *
 * The two branches write the same checkpoint, under the same name, at the same position — every
 * difference between them lives in the RUNNER's own positions (`ctx.child` suspends and joins;
 * `ctx.startChild` records a `spawn:` and moves on). That is deliberate: which branch a call takes
 * is decided by `persist:toolcall`, whose answer comes out of the journal, so the loop's sequence
 * cannot depend on a registry the replaying process happens to hold.
 */
async function delegateToolCall(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolResult> {
  const { deps, input, hooks } = turn;
  const { call, targetAgent = call.name } = claimed;
  const task = extractTask(call.input);
  // A detached hop counts like any other: a cycle is cheaper to start that way, not less unbounded.
  const refusal = delegationRefusal({ deps, input, targetAgent });
  const start = claimed.detached === true && refusal === null ? hooks.startAgent : undefined;
  publishAgentDelegated({
    runId: hooks.runId,
    toAgent: targetAgent,
    ...(input.agentName !== undefined ? { fromAgent: input.agentName } : {}),
    ...(start !== undefined ? { detached: true } : {}),
  });
  let sub: { text: string } | DetachedDelegationReceipt;
  if (refusal !== null) {
    sub = { text: refusal };
  } else if (start !== undefined) {
    const started = await start({ agentName: targetAgent, task, toolCallId: call.id });
    sub = detachedStarted({ agent: targetAgent, runId: started.runId });
  } else if (hooks.runAgent) {
    sub = await hooks.runAgent(targetAgent, task);
  } else {
    sub = { text: `(no multi-agent support wired; cannot reach "${targetAgent}")` };
  }
  await hooks.step(`persist:toolexec:${call.id}`, () =>
    deps.store.updateToolCall({ toolCallId: call.id, status: 'executed', output: sub }),
  );
  return { id: call.id, name: call.name, output: sub };
}

/**
 * Settle an `ask` call against a human. The model authored the questions, so unlike the configured
 * intake there is nothing to persist first — `persist:toolcall` already wrote the row, under the
 * same name and at the same position any other kind would have used.
 *
 * Costs nothing beyond the step that produced it: the question set arrived as the ARGUMENTS of a
 * tool call the model was already making, in a step already billed as `chat`. There is no second
 * model call and therefore no usage row of its own — the opposite of the structured-output pass,
 * which really does buy an extra call.
 *
 * The two new positions here (`stream:elicitation:<id>`, and the wait) are reachable only when this
 * call's journaled kind is `ask`, which no run recorded before the kind existed. Every replay reads
 * that kind back rather than re-deciding it, so no run can disagree about whether they are there.
 */
async function elicitToolCall(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolResult> {
  const { deps, hooks } = turn;
  const { call, ctx } = claimed;
  // Validated HERE rather than by the registry, which never sees this tool. Deterministic on the
  // same footing as `validateStructured`: a module-constant schema over an input the `llm:<i>`
  // checkpoint already holds, so every replay reaches the same verdict — and the same branch.
  const parsed = await askInputSchema['~standard'].validate(call.input);
  if (parsed.issues !== undefined) {
    const error = `invalid ask input: ${parsed.issues.map((each) => `${(each.path ?? []).join('.') || '(root)'}: ${each.message}`).join('; ')}`;
    await hooks.step(`persist:toolfail:${call.id}`, () =>
      deps.store.updateToolCall({ toolCallId: call.id, status: 'failed', error }),
    );
    // A malformed question set is the model's mistake to fix, so it comes back as a tool failure —
    // the vocabulary the model already knows how to answer — rather than failing the run.
    return { id: call.id, name: call.name, output: null, error };
  }
  const request: ElicitationRequest = {
    id: call.id,
    source: 'ask',
    questions: parsed.value.questions,
    ...(parsed.value.preamble !== undefined ? { preamble: parsed.value.preamble } : {}),
  };
  await hooks.step(`stream:elicitation:${call.id}`, async () => {
    await turn.writer.write(encodeStreamEvent({ kind: 'elicitation', id: call.id, request }));
  });
  const reply = await awaitElicitation(hooks, request, ctx);
  const result = settleElicitation(request, reply);
  await hooks.step(
    result.skipped ? `persist:toolreject:${call.id}` : `persist:toolexec:${call.id}`,
    () =>
      deps.store.updateToolCall({
        toolCallId: call.id,
        status: result.skipped ? 'rejected' : 'executed',
        output: result,
        ...(result.skipped ? { error: 'skipped by the user' } : {}),
        ...(reply.answeredByRef !== undefined ? { executedByRef: reply.answeredByRef } : {}),
      }),
  );
  publishAgentToolCall({
    runId: hooks.runId,
    toolName: call.name,
    toolType: 'action',
    status: result.skipped ? 'rejected' : 'executed',
  });
  return { id: call.id, name: call.name, output: result };
}

/** Everything a claimed call still needs, on its own: delegation or approval, then execute. */
async function runClaimedToolCall(
  turn: ToolTurnContext,
  claimed: ClaimedToolCall,
): Promise<ToolResult> {
  const { deps, input, hooks } = turn;
  const { call, toolType, ctx } = claimed;
  // Delegation is handled at the LOOP level (not in a step) because the durable runner maps it to
  // `ctx.child`, a ctx-level suspend point.
  if (toolType === 'agent') {
    return delegateToolCall(turn, claimed);
  }
  // An `ask` never reaches a handler: it is settled by a person, not executed.
  if (toolType === 'ask') {
    return elicitToolCall(turn, claimed);
  }
  // WHO settled an action tool: the Decision's ref (a console admin) when it carries one, else
  // the run's own actor (the chat flow). Stamped on both the executed and rejected persists.
  let deciderRef = input.actor.id;
  if (toolType === 'action') {
    const decision = await hooks.awaitApproval(call, ctx);
    deciderRef = decision.executedByRef ?? input.actor.id;
    if (!decision.approved) {
      await hooks.step(`persist:toolreject:${call.id}`, () =>
        deps.store.updateToolCall({
          toolCallId: call.id,
          status: 'rejected',
          executedByRef: deciderRef,
          ...(decision.reason !== undefined ? { error: decision.reason } : {}),
        }),
      );
      publishAgentToolCall({
        runId: hooks.runId,
        toolName: call.name,
        toolType,
        status: 'rejected',
      });
      return {
        id: call.id,
        name: call.name,
        output: { rejected: true, reason: decision.reason ?? DEFAULT_REFUSAL_REASON },
        denied: true,
        // What the MODEL is told. It used to be the bare word `rejected`, which names no actor and
        // reads exactly like a tool that blew up — so the answer that followed would speculate about
        // causes ("the key may not exist", "there may be permission restrictions") and offer to try
        // again. A person's decision is not a fault to diagnose, so this says who decided, that
        // nothing ran, and what not to do next.
        error: refusalNarrative(decision.reason),
      };
    }
  }
  return recordToolOutcome(turn, claimed, await invokeClaimedTool(turn, claimed), deciderRef);
}

/**
 * The frame a settled call is streamed on. A refusal is its own kind, ahead of the error branch:
 * `denied` and `error` are both set on a declined call — the first for every consumer, the second
 * because `error` is the channel a model reads an outcome on — and a client that saw the error
 * frame would draw a person's "no" as a malfunction.
 */
function outputFrame(result: ToolResult): AgentStreamEvent {
  if (result.denied === true) {
    const reason = refusalReason(result);
    return {
      kind: 'tool-output-denied',
      id: result.id,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  return result.error !== undefined
    ? { kind: 'tool-output-error', id: result.id, error: result.error }
    : { kind: 'tool-output', id: result.id, output: result.output };
}

/** The reason a person gave when declining, if they gave one — read back off the result. */
function refusalReason(result: ToolResult): string | undefined {
  const { output } = result;
  if (output !== null && typeof output === 'object' && 'reason' in output) {
    const reason = (output as { reason: unknown }).reason;
    return typeof reason === 'string' && reason !== DEFAULT_REFUSAL_REASON ? reason : undefined;
  }
  return undefined;
}

/**
 * Stored as the reason when someone declines without giving one. It is a placeholder, not something
 * a person said, so every reader has to filter it out — which is why it is exported rather than
 * spelled again wherever a refusal is read back.
 */
export const DEFAULT_REFUSAL_REASON = 'rejected by user';

/**
 * How a refusal is put to the model. Written as instructions rather than as a status because the
 * model's next move is the whole problem: told only that something was "rejected", it treats the
 * refusal as a fault, lists possible causes it cannot check, and offers to retry the same action —
 * which asks the person to say no twice.
 */
function refusalNarrative(reason: string | undefined): string {
  const base =
    'The person was asked to approve this action and declined it. Nothing ran and nothing changed. ' +
    'This is their decision, not an error, a missing record or a permissions problem — do not ' +
    'explain it as one, do not guess at causes, and do not run this action again or reach for ' +
    'another way to do the same thing. Acknowledge the decision and ask what they would like instead.';
  return reason === undefined ? base : `${base} They said: ${reason}`;
}

/**
 * Overlap the INVOCATIONS of a batch of claimed calls, and only those. The persist checkpoints on
 * either side stay strictly sequential, in call order — they are asked for after their neighbours'
 * positions are already spent, so nothing about them depends on which tool finished first.
 *
 * A rejection here is the runner unwinding the turn, never a tool's own failure
 * ({@link invokeClaimedTool} reports those). Rethrow the first one in call order and persist
 * NOTHING: the resume replays this whole block, and a `persist:toolexec` written now would sit at
 * the position the replay computes for the FIRST call's — which, when the invocations are dispatched
 * steps, all share one checkpoint name, so the mismatch raises no refusal at all and simply hands
 * one call's output to another.
 */
async function invokeClaimedToolsTogether(
  turn: ToolTurnContext,
  parallel: NonNullable<AgentLoopHooks['parallel']>,
  claimed: ClaimedToolCall[],
): Promise<ToolResult[]> {
  const settled = await parallel(claimed.map((entry) => () => invokeClaimedTool(turn, entry)));
  for (const outcome of settled) {
    if (!outcome.ok) {
      throw outcome.error;
    }
  }
  const results: ToolResult[] = [];
  for (const [index, entry] of claimed.entries()) {
    const outcome = settled[index];
    if (outcome?.ok === true) {
      results.push(await recordToolOutcome(turn, entry, outcome.value, turn.input.actor.id));
    }
  }
  return results;
}

/**
 * Something the LOOP produced that the model did not ask for — retrieved passages, a validated
 * structured answer — carried to a client as an ordinary auto-executed tool call. It rides the
 * assistant message it informed (calls and results both, so a reader can pair them), a row in the
 * tool-call table (so a governance surface counts it), and a live pair of stream frames.
 */
interface SyntheticToolCall {
  /** The checkpoint that records the row, minus its `:<messageId>` suffix. */
  step: string;
  call: ToolCallRequest;
  result: ToolResult;
}

/** What a turn answered with: the assistant text, plus the validated `outputSchema` value if any. */
export interface AgentLoopResult<TOutput = unknown> {
  text: string;
  /** Present only when `AgentLoopDeps.outputSchema` was set — the validated structured answer. */
  object?: TOutput;
}

/**
 * The provider-agnostic agent turn, reused by both the inline and durable runners.
 * It drives the model→tools→model iteration; the runner supplies the `step`/`awaitApproval`
 * hooks that make the same loop body either in-process or a replay-safe durable workflow.
 */
export async function runAgentLoop<TOutput = unknown>(
  deps: AgentLoopDeps<TOutput>,
  input: AgentRunInput,
  hooks: AgentLoopHooks,
): Promise<AgentLoopResult<TOutput>> {
  const maxSteps = deps.maxSteps ?? 8;
  let system = await resolveSystemPrompt(deps, input);
  const inputProcessors = deps.inputProcessors ?? [];
  const outputProcessors = deps.outputProcessors ?? [];
  // An output gate and the run's own sink are mutually exclusive, so the presence of a processor —
  // not a per-turn condition — decides whether the model call writes to the sink or through a gate.
  // What the chain DECLARES then decides what that costs the reader: an incremental chain releases a
  // lookback-bounded prefix as it arrives, an undeclared one holds the answer whole.
  const gateMode = resolveOutputGateMode(outputProcessors);
  const gated = gateMode !== 'off';
  const gateLookback = resolveGateLookback(outputProcessors);
  let structured: TOutput | undefined;

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
        runId: hooks.runId,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      }),
    );
  }

  const history = (await (hooks.patched?.(SELECTED_HISTORY_PATCH) ?? Promise.resolve(true)))
    ? await loadSelectedHistory(deps, input, hooks)
    : await loadWholeThread(deps, input, hooks);
  let modelMessages: ModelMessage[] = history.messages;
  const summarize = deps.historyPolicy?.summarize?.bind(deps.historyPolicy);
  if (summarize !== undefined && history.dropped.length > 0) {
    modelMessages = await foldDroppedHistory(summarize, deps, input, hooks, history);
  }

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

  // Which of the three optional prompt stages below this run takes a position for, decided ONCE and
  // journaled — see {@link PromptStages}. Every `stages.*` read after this is therefore a fact about
  // the run rather than about the deployment replaying it, which is what lets a turn parked on a
  // human survive an operator switching one of them on.
  const stages = await resolvePromptStages(deps, hooks);

  // Its own step so durable replay reuses the ORIGINAL wall-clock start — durationMs stays honest
  // across suspend/resume.
  const startedAt = await hooks.step('run:started-at', () => Promise.resolve(Date.now()));
  // Optional-chained: a store without run recording makes this (and persist:run:end) a no-op.
  await hooks.step('persist:run:start', async () => {
    // Hashed BEFORE the retrieved-context block is folded in below, so the hash identifies the
    // prompt VERSION (agent base + contributors), not a given turn's retrieval.
    const promptHash = createHash('sha256').update(system).digest('hex');
    await deps.store.recordRunStart?.({
      runId: hooks.runId,
      threadId: input.threadId,
      actorRef: input.actor.id,
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      promptHash,
    });
  });

  // What the assistant already believes about this person, folded in ABOVE the retrieved passages
  // and the skills catalog — see `AgentLoopDeps.memory` for why the order runs most-durable-first.
  // Below `persist:run:start` on purpose: that step hashes the prompt VERSION, and a hash that moved
  // with whose memory was loaded would identify a person rather than a prompt.
  //
  // One checkpoint, holding the WHOLE digest: the scopes the resolver returned and the entries that
  // survived selection, precedence and the ceiling. That payload is what the block is rendered from
  // AND what a later `remember` call is authorized against — so which memories entered this prompt,
  // and which scopes this turn could write, are facts the journal holds rather than answers a
  // replaying process's provider would give afresh. Where the host runs an index, the SEARCH happens
  // in here too: a ranking is the most re-derivable decision in this library, so a replay has to
  // read its result back rather than ask an index that has since moved.
  //
  // THE QUERY IS THE USER'S OWN MESSAGE, and nothing else. It is the only thing available before the
  // first model call — which is where memory has to be, since a memory is worthless unless it is in
  // front of the model on the turn nobody thought to look — and it is already a journaled input to
  // this run, so it needs no determinism machinery of its own. What it fails at is a turn with no
  // topic ("and the other thing?"): `pinned` is the answer to those, not a cleverer query.
  let memoryDigest: MemoryDigest | undefined;
  if (stages.memory) {
    const config = deps.memory;
    memoryDigest = await hooks.step('memory:digest', () =>
      config === undefined
        ? Promise.resolve(UNSERVED_MEMORY)
        : offerMemories({ config, ctx: skillContext(input), query: input.userText }),
    );
    // No entries, no block: an actor the assistant has concluded nothing about pays nothing, rather
    // than reading a heading over an empty list and inferring something from its presence.
    const digest = memoryDigest;
    const block =
      digest.entries.length > 0
        ? buildMemoryBlock({
            entries: digest.entries,
            writable: memoryIsWritable(deps),
            partial: digest.omitted > 0 || digest.recalled === true,
          })
        : '';
    if (block.length > 0) {
      system = `${system}\n\n${block}`;
    }
    // What memory cost this prompt, next to what the ceiling left out — the only way an operator can
    // name which of the prompt's contributors grew when a turn's input tokens jump.
    publishAgentMemoryResolved({
      runId: hooks.runId,
      scopes: digest.scopes.length,
      offered: digest.entries.length,
      omitted: digest.omitted,
      pinnedOmitted: digest.pinnedOmitted,
      recalled: digest.recalled === true,
      promptChars: block.length,
    });
  }

  // Inject-mode RAG: retrieve once for the user message and fold the passages into the system prompt
  // (a `ctx.step` so it's replay-cached under durable). Recorded below as a synthetic tool call on
  // the first assistant message, so citations surface through the same machinery as agentic search.
  let injectedPassages: Passage[] | undefined;
  if (stages.retriever) {
    const retriever = deps.retriever;
    const topK = deps.retrievalTopK ?? 5;
    const passages = await hooks.step('retrieve', () =>
      spanned(
        'retrieval',
        hooks.runId,
        { runId: hooks.runId, queryLength: input.userText.length, topK },
        () => retriever?.retrieve(input.userText, { topK }) ?? Promise.resolve([]),
        (retrieved) => ({ count: retrieved.length }),
      ),
    );
    if (passages.length > 0) {
      injectedPassages = passages;
      system = `${system}\n\n${buildContextBlock(passages)}`;
    }
    publishAgentRetrieved({ runId: hooks.runId, query: input.userText, count: passages.length });
  }

  // The skills catalog, LAST of the four things that write the system block (base prompt,
  // contributors, retrieved context, this) — so a reader of the assembled prompt meets the agent's
  // own instructions before the menu of ones it could go and fetch.
  //
  // One checkpoint, holding the WHOLE offer: the scopes the resolver returned and the entries that
  // survived precedence. That payload is what the block is rendered from and what a later `skill`
  // call is served against, so the two things a turn's prompt depends on — which scopes applied, and
  // which skills they yielded — are facts the journal holds rather than answers a replaying
  // process's provider would give afresh.
  let skillOffer: SkillOffer | undefined;
  if (stages.skills) {
    const config = deps.skills;
    skillOffer = await hooks.step('skills:catalog', () =>
      config === undefined
        ? Promise.resolve(UNSERVED_SKILLS)
        : offerSkills(config, skillContext(input)),
    );
    // No entries, no block: an actor whose scopes yield nothing pays nothing, rather than reading a
    // heading over an empty list and wondering what it was for.
    const block = skillOffer.entries.length > 0 ? buildSkillsBlock(skillOffer.entries) : '';
    if (block.length > 0) {
      system = `${system}\n\n${block}`;
    }
    // What skills cost this prompt, reported next to what they left out — the only way an operator
    // can name which of the prompt's contributors grew when a turn's input tokens jump.
    publishAgentSkillsResolved({
      runId: hooks.runId,
      scopes: skillOffer.scopes.length,
      offered: skillOffer.entries.length,
      omitted: skillOffer.omitted,
      promptChars: block.length,
    });
  }

  // Fetched ONCE per run (not per step/message) and reused for every step's cost estimate below.
  // Returned as a plain array (not the Map built from it) so durable replay can JSON-cache the step.
  let prices: CurrentModelPrice[] = [];
  if (deps.pricingStore !== undefined) {
    const pricingStore = deps.pricingStore;
    prices = await hooks.step('pricing:list', () => pricingStore.listCurrentPrices());
  }
  const priceByModel = new Map(prices.map((price) => [price.modelId, price]));

  // The configured intake, LAST before the first model call: everything the run records about
  // itself (start time, run row, retrieval, prices) is settled before the turn parks on a person,
  // who may take a day. Its whole block is reachable only through `deps.intake`.
  if (deps.intake !== undefined) {
    const asked = await runIntake(
      deps.intake,
      deps,
      input,
      hooks,
      writer,
      history.hasAssistantMessage,
    );
    if (asked !== null) {
      modelMessages.push(asked);
    }
  }

  // Whether this run can observe a cancel at all, resolved ONCE at a fixed position rather than per
  // step: `patched` consumes a position of its own for a fresh run and gives it back to an in-flight
  // one, so asking once is both cheaper and the only form whose cost does not depend on how many
  // steps a turn happens to take. Gated on the hook's presence, which is a property of the runner
  // (uniform across a deployment's pods), never of the run.
  const cancellable =
    hooks.cancelled !== undefined &&
    (await (hooks.patched?.(CANCELLATION_PATCH) ?? Promise.resolve(true)));

  // NOTE: no try/finally around this loop. A durable runner suspends by THROWING through the stack
  // at `awaitApproval` (ctx.waitForSignal); a finally would then call writer.end() on every suspend
  // and prematurely close the live stream. We only end on normal completion — the throw propagates
  // to the engine, and the resumed replay reaches the writer.end() below.
  for (let i = 0; i < maxSteps; i += 1) {
    // Between steps, and therefore before the next model call: the cheapest point in the turn to
    // stop at, since nothing has been spent on this step yet.
    await haltIfCancelled(hooks, cancellable, `cancel:check:${i}`);

    // Open a UI step spanning this model call AND its tool execution — matching the AI SDK's own
    // step semantics, so tool-output lands inside the step that made the call. Wrapped in a durable
    // step so replay doesn't re-emit it (a no-op for the inline runner).
    await hooks.step(`stream:step-start:${i}`, async () => {
      await writer.write(encodeStreamEvent({ kind: 'step-start' }));
    });

    // Every step, not once per run: the transcript grows between steps, so a processor that only
    // saw the opening prompt would wave through whatever a tool result carried back. The result is
    // a per-step DERIVED prompt — `modelMessages` stays the loop's canonical transcript, so a
    // redaction never becomes the thread's own memory of what was said.
    let prompt: ProcessedPrompt = { system, messages: modelMessages };
    if (inputProcessors.length > 0) {
      prompt = await hooks.step(`process:input:${i}`, () =>
        runInputProcessors(inputProcessors, prompt, processorContext(input, i)),
      );
    }

    let turn: BufferedModelTurnResult;
    if (hooks.dispatchLlm) {
      // No definitionsFor here: the envelope carries only wire-safe data (a ToolDefinition holds a
      // live schema instance) — the serving handler re-derives tool definitions from the actor.
      // `bufferOutput` for EITHER gate mode, incremental included: the handler streams into a
      // worker-side sink this loop cannot interpose on, so there is no prefix to release here and
      // the declaration buys the reader nothing. The turn is held whole — the result comes back with
      // `bufferedFrames` and no `releasedText`, which is what puts the gate step on its whole-answer
      // release path.
      turn = await hooks.dispatchLlm(i, {
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        system: prompt.system,
        messages: prompt.messages,
        actor: input.actor,
        ...(gated ? { bufferOutput: true } : {}),
      });
    } else {
      const tools = withMemoryTool({
        tools: withSkillTool({
          tools: withAskTool({
            tools: await deps.registry.definitionsFor(
              input.actor,
              deps.rolesPolicy,
              deps.toolAllowList,
            ),
            ask: deps.ask,
          }),
          enabled: deps.skills !== undefined,
        }),
        enabled: memoryIsWritable(deps),
      });
      turn = await hooks.step(`llm:${i}`, async () => {
        // Both of these ride the CHECKPOINT rather than a local variable: a run that suspends
        // between the model call and the gate resumes with `llm:<i>` served from the journal, and
        // state held in this process would be gone by then — the turn's whole stream, silently
        // dropped, or a prefix flushed into the reader's stream a second time.
        const incremental =
          gateMode === 'incremental'
            ? createIncrementalGate({
                processors: outputProcessors,
                ctx: processorContext(input, i),
                lookbackChars: gateLookback,
                writer,
              })
            : undefined;
        const buffer = gateMode === 'whole' ? createFrameBuffer() : undefined;
        // Stamped from THIS process's registry, which is the one that built `tools` above — and
        // stamped inside the checkpoint, so the kinds are journaled with the calls they describe
        // rather than re-derived by whatever process replays this turn.
        const result = stampToolKinds(
          await traceLlmTurn(hooks.runId, i, () =>
            deps.model.runTurn({
              system: prompt.system,
              messages: prompt.messages,
              tools,
              sink: incremental?.writer ?? buffer?.writer ?? writer,
            }),
          ),
          deps,
        );
        if (incremental !== undefined) {
          await incremental.settled();
          const refusal = incremental.rejection();
          return {
            ...result,
            releasedText: incremental.released(),
            ...(refusal !== undefined ? { gateRejection: refusal } : {}),
          };
        }
        return buffer === undefined ? result : { ...result, bufferedFrames: buffer.frames() };
      });
    }
    // The gate runs before ANYTHING downstream: before the held frames reach the subscriber, before
    // the assistant message is persisted, before this text becomes the next step's context.
    let rejection: { processor: string; reason: string } | undefined;
    if (gated) {
      const gate = await hooks.step(`process:output:${i}`, async () => {
        // Which release this turn still owes is read from the JOURNALED model result, never from
        // the chain configured on whichever process is running now: `releasedText` is the record
        // that a prefix already reached the reader, so a run that resumes under a re-declared chain
        // cannot flush the same answer a second time.
        const released = turn.releasedText;
        // A refusal an incremental gate already reached, carried out of `llm:<i>` instead of thrown
        // from it. Re-running the chain would bill the same verdict twice.
        if (turn.gateRejection !== undefined) {
          return { text: turn.text, rejection: turn.gateRejection };
        }
        const settled = await runOutputProcessors(
          outputProcessors,
          { text: turn.text, toolCalls: turn.toolCalls },
          processorContext(input, i),
        );
        // Releasing inside the same checkpoint as the verdict is what makes "refused" and "nothing
        // was streamed" one fact rather than two that a suspend could separate. For an incremental
        // turn the second half of that is weaker by construction — a prefix is already out — and
        // the whole-answer pass stays authoritative for both the stream and the store.
        if (settled.rejection === undefined) {
          if (released === undefined) {
            for (const chunk of releaseGatedFrames(turn.bufferedFrames ?? [], settled.text)) {
              await writer.write(chunk);
            }
          } else {
            const tail = gateTail(outputProcessors, released, settled.text);
            if (tail.length > 0) {
              await writer.write(encodeStreamEvent({ kind: 'text', text: tail }));
            }
          }
        }
        return settled;
      });
      rejection = gate.rejection;
      turn = { ...turn, text: gate.text };
    }
    // provider-reported model wins over the configured fallback, so cost can't misattribute
    const resolvedModelId = turn.modelId ?? deps.modelId ?? 'unknown';
    // Provider-reported spend wins; else an estimate from the (once-per-run cached) price list; else
    // `null` — surfaced on the stream's step-finish frame and the persisted assistant message below.
    const costUsd = resolveCostUsd(turn.usage, turn.costUsd, priceByModel.get(resolvedModelId));
    // Each call's declared kind, so thread-read consumers (and the stream frames the model adapter
    // writes) know it without hardcoding a tool-name allowlist. The kind the llm checkpoint already
    // stamped WINS: it came from the process that offered the tool, whereas this one is only the
    // process replaying the turn, and the two disagree exactly when that matters — see
    // {@link stampToolKinds}. The fallback is for a journal written before kinds travelled.
    const toolCallsWithKind: ToolCallRequest[] = turn.toolCalls.map((call) => ({
      ...call,
      kind: call.kind ?? declaredKind(deps, call.name),
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

    // Thrown only AFTER the two accounting checkpoints: those tokens were genuinely spent, and a
    // refusal that also hid its own cost would let a mis-tuned gate burn a budget invisibly.
    if (rejection !== undefined) {
      throw new OutputRejectedError(rejection.processor, rejection.reason);
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
    // Restating the GATED text, never the model's raw reply: the formatting pass is a translation of
    // the answer that survived the gate, not a second route out of the model.
    if (isFinalTurn && deps.outputSchema !== undefined) {
      structured = await structureAnswer(
        deps.outputSchema,
        deps,
        input,
        hooks,
        restatementPrompt(prompt.messages, turn.text, deps.outputFromTranscript === true),
        i,
      );
    }
    let followUps: string[] | undefined;
    if (isFinalTurn && deps.followUpsCount !== undefined && deps.followUpsCount > 0) {
      const count = deps.followUpsCount;
      // Stays on hooks.step (not dispatchLlm) — a short, non-streamed call, deliberately not
      // dispatched as a routed remote step.
      const generated = await hooks.step(`followups:${i}`, () =>
        spanned(
          'follow-ups',
          hooks.runId,
          { runId: hooks.runId, step: i, count },
          () =>
            generateFollowUps(
              deps.model,
              [...modelMessages, { role: 'assistant', content: turn.text }],
              count,
            ),
          (result) => ({
            followUps: result.followUps.length,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(result.modelId !== undefined ? { modelId: result.modelId } : {}),
          }),
        ),
      );
      // Model-generated, persisted and rendered — so the chain rules on each one, on the whole
      // suggestion (they are never streamed, so an `incremental` declaration buys nothing here). A
      // refusal DROPS that suggestion rather than ending a run whose answer already passed — see
      // {@link gateFollowUps}.
      let suggestions = generated.followUps;
      if (outputProcessors.length > 0) {
        suggestions = await hooks.step(`process:output:followups:${i}`, () =>
          gateFollowUps(outputProcessors, suggestions, processorContext(input, i)),
        );
      }
      if (suggestions.length > 0) {
        followUps = suggestions;
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

    // Inject-mode retrieval and the structured answer both reach a client as ordinary tool calls.
    // Their ids are derived from the RUN, not from the message they hang off, because the message
    // does not exist yet and both have to be on the append below: a reader pairs a call with its
    // result off the message, so a call added afterwards would render as a tool still running.
    // Every value here is already settled by a checkpoint this turn ran (`retrieve`,
    // `structured:<step>:<n>`), so a replay rebuilds the same pair without minting anything.
    const synthetic: SyntheticToolCall[] = [];
    if (i === 0 && injectedPassages !== undefined) {
      const call: ToolCallRequest = {
        id: `retrieve-${hooks.runId}`,
        name: 'retrieve',
        input: { query: input.userText },
        kind: 'read',
      };
      const output = { passages: injectedPassages };
      synthetic.push({
        step: 'persist:retrieval',
        call,
        result: { id: call.id, name: call.name, output },
      });
    }
    if (structured !== undefined) {
      const call: ToolCallRequest = {
        id: `structured-${hooks.runId}`,
        name: 'structured_output',
        input: {},
        kind: 'read',
      };
      synthetic.push({
        step: 'persist:structured',
        call,
        result: { id: call.id, name: call.name, output: structured },
      });
    }
    const messageCalls = [...toolCallsWithKind, ...synthetic.map((entry) => entry.call)];
    const syntheticResults = synthetic.map((entry) => entry.result);

    const assistant = await hooks.step(`persist:assistant:${i}`, () =>
      deps.store.appendMessage({
        threadId: input.threadId,
        role: 'assistant',
        content: turn.text,
        // Stamps which turn wrote this message, so a reader does not have to infer it from
        // timestamps — an inference a regenerate breaks, since it re-answers a surviving prompt.
        runId: hooks.runId,
        usage: { ...turn.usage, costUsd },
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        ...(messageCalls.length > 0 ? { toolCalls: messageCalls } : {}),
        ...(syntheticResults.length > 0 ? { toolResults: syntheticResults } : {}),
        ...(followUps !== undefined ? { followUps } : {}),
      }),
    );
    // Tool results ride on the same assistant message that made the calls — the compact shape the
    // store persists and `mapMessages` (in every model adapter) expands into an assistant + tool
    // message pair. We keep the reference and attach the model's own `toolResults` below once the
    // tools have run.
    const assistantMessage: ModelMessage = {
      role: 'assistant',
      content: turn.text,
      ...(messageCalls.length > 0 ? { toolCalls: messageCalls } : {}),
      ...(syntheticResults.length > 0 ? { toolResults: syntheticResults } : {}),
    };
    modelMessages.push(assistantMessage);

    for (const entry of synthetic) {
      const { call, result } = entry;
      await hooks.step(`${entry.step}:${assistant.id}`, async () => {
        await deps.store.recordToolCall({
          toolCallId: call.id,
          messageId: assistant.id,
          toolName: call.name,
          toolType: 'read',
          input: call.input,
          status: 'auto_executed',
          runId: hooks.runId,
        });
        await deps.store.updateToolCall({
          toolCallId: call.id,
          status: 'executed',
          output: result.output,
        });
        // The same pair of frames an executed read tool writes, so a live subscriber renders this
        // through the tool-call machinery it already has rather than learning a frame kind.
        await writer.write(
          encodeStreamEvent({
            kind: 'tool-input-available',
            id: call.id,
            name: call.name,
            input: call.input,
            toolKind: 'read',
          }),
        );
        await writer.write(
          encodeStreamEvent({ kind: 'tool-output', id: call.id, output: result.output }),
        );
      });
    }

    if (isFinalTurn) {
      await hooks.step(`stream:step-finish:${i}`, async () => {
        await writer.write(encodeStreamEvent({ kind: 'step-finish', usage: turn.usage, costUsd }));
      });
      break;
    }

    // Before the turn's tools are DISPATCHED — the last point at which stopping costs nothing,
    // because the moment the first handler runs there is a side effect no cancel can take back. One
    // observation for the whole batch rather than one per call: the calls are a single ask from the
    // model, and stopping half way through leaves the next step reading a message whose tool results
    // it cannot pair with the calls above them.
    await haltIfCancelled(hooks, cancellable, `cancel:tools:${i}`);

    const results: ToolResult[] = [];
    const turnCalls: ToolTurnContext = {
      deps,
      input,
      hooks,
      messageId: assistant.id,
      writer,
      ...(skillOffer !== undefined ? { skills: skillOffer } : {}),
      ...(memoryDigest !== undefined ? { memory: memoryDigest } : {}),
    };
    // A model routinely asks for several tools at once, and running them back to back makes the turn
    // cost their sum. Overlapping them is safe here because a checkpoint position is handed out on
    // the CALL, not when the work settles: launching every invocation in one tick — what
    // `hooks.parallel` promises — pins the `tool:` block in call order however the tools then finish,
    // the same anchor `ctx.all` gets by reserving its block before dispatching. The claim and persist
    // checkpoints stay sequential around it.
    //
    // Only a turn whose every call is a plain `read` qualifies:
    //   - an `action` suspends on an approval signal, which is human time rather than I/O, so
    //     overlapping what follows it buys nothing — and reserving an invocation position for a call
    //     that may yet be REJECTED spends a position the rejected branch never fills.
    //   - an `agent` delegation is `ctx.child`, whose parallel form is the runtime's own `ctx.all`:
    //     one workflow ref over a reserved block, carrying the `parallelGroup` bookkeeping that makes
    //     a fan render as a fan. That is not N independent task closures, so it cannot ride this hook.
    // The kinds come from the `persist:toolcall` checkpoints, never from a local registry lookup, so
    // every process replaying this turn reaches the same verdict.
    const parallel = hooks.parallel;
    if (
      parallel !== undefined &&
      toolCallsWithKind.length > 1 &&
      (await (hooks.patched?.(PARALLEL_TOOLS_PATCH) ?? Promise.resolve(true)))
    ) {
      // Claiming the whole turn first is what makes the kinds knowable before the first execution —
      // and it is also what moves the checkpoints, hence the `patched` gate above.
      const claimed: ClaimedToolCall[] = [];
      for (const call of toolCallsWithKind) {
        claimed.push(await claimToolCall(turnCalls, call));
      }
      // A `skill` load and a `remember` write qualify alongside a `read`: each takes its position on
      // the call exactly as a read does, and each spends a read's `tool:`/`persist:` names. What
      // disqualifies the other two kinds is not that they have effects — it is that an `action`
      // suspends on human time and an `agent` delegation is the runtime's own `ctx.all`.
      if (
        claimed.every(
          (entry) =>
            entry.toolType === 'read' || entry.toolType === 'skill' || entry.toolType === 'memory',
        )
      ) {
        results.push(...(await invokeClaimedToolsTogether(turnCalls, parallel, claimed)));
      } else {
        for (const entry of claimed) {
          results.push(await runClaimedToolCall(turnCalls, entry));
        }
      }
    } else {
      for (const call of toolCallsWithKind) {
        results.push(await runClaimedToolCall(turnCalls, await claimToolCall(turnCalls, call)));
      }
    }
    const settledResults = [...results, ...syntheticResults];
    assistantMessage.toolResults = settledResults;

    // Stream each tool's result so the client flips its live tool card from "running" to the
    // rendered output (renderResult → DataTable/Chart, executeSql → rows). One durable step keeps
    // replay from re-emitting. Which frame each result goes out on is `outputFrame`'s call: a
    // refusal has its own, and `error` carries only what the model is told.
    await hooks.step(`stream:tool-outputs:${i}`, async () => {
      // The results land on the message from INSIDE this checkpoint rather than at one of their
      // own: this turn's checkpoint sequence is a wire contract with every run already in flight,
      // and a position inserted between two recorded ones is refused on resume. Every value in
      // `settledResults` comes from a checkpoint above, so a replay writes the same list anyway.
      await deps.store.setMessageToolResults(assistant.id, settledResults);
      for (const result of results) {
        await writer.write(encodeStreamEvent(outputFrame(result)));
      }
    });

    await hooks.step(`stream:step-finish:${i}`, async () => {
      await writer.write(encodeStreamEvent({ kind: 'step-finish', usage: turn.usage, costUsd }));
    });
  }

  if (history.title === '' || history.title === 'New chat') {
    await hooks.step('persist:title', () =>
      deps.store.setTitle(input.threadId, deriveTitle(input.userText)),
    );
  }

  const delivery = input.deliverTo;
  if (delivery !== undefined) {
    // A detached run's answer has nowhere to go but a message of its own: the turn that delegated it
    // ended without it, so there is no tool result left to fill and no live stream to write into.
    // Stamped with THIS run and agent, which is how a reader tells "the research agent finished"
    // from the assistant's next reply.
    //
    // The position exists only for a run carrying a delivery address, and only a detached
    // delegation's own child run carries one — so the sequence of every other turn is untouched.
    await hooks.step('deliver:detached', async () => {
      if ((await deps.store.getThread(delivery.threadId)) === null) {
        // The conversation was deleted while this ran. The work cannot be un-run, but delivering
        // into a thread nobody kept would resurrect it, and the tool-call row it would settle went
        // with it.
        return;
      }
      const agent = input.agentName ?? 'default';
      await deps.store.appendMessage({
        threadId: delivery.threadId,
        role: 'assistant',
        content: lastText,
        agentName: agent,
        runId: hooks.runId,
      });
      await deps.store.updateToolCall({
        toolCallId: delivery.toolCallId,
        status: 'executed',
        output: detachedDelivered({ agent, runId: hooks.runId, text: lastText }),
      });
    });
  }

  // Normal completion only. The loop never records 'failed' — it doesn't catch its own crash;
  // failure recording is the RUNNER's job. A checkpointed step, so a resumed replay settles once.
  await hooks.step('persist:run:end', async () => {
    await deps.store.recordRunEnd?.({
      runId: hooks.runId,
      status: 'completed',
      durationMs: Date.now() - startedAt,
    });
  });

  await writer.end();
  publishAgentRunFinished({
    runId: hooks.runId,
    threadId: input.threadId,
    steps,
    inputTokens: totalInput,
    outputTokens: totalOutput,
  });
  return { text: lastText, ...(structured !== undefined ? { object: structured } : {}) };
}
