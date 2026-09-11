import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentIntake, ElicitationReply } from './elicitation.js';
import type { AgentHistoryWindow } from './spi/history-policy.js';
import type { ToolTransientRetryNumbers } from './tool-retry.js';

/** Who is driving the turn. Roles + tenant come from the host app (nestjs-context/authz). */
export interface Actor {
  id: string;
  /** The caller's roles. Tool authorization is a set intersection against a tool's `roles`. */
  roles?: string[];
  tenantRef?: string;
}

export type ToolKind = 'read' | 'action' | 'agent' | 'ask' | 'skill' | 'memory';

/**
 * One agent->agent edge on {@link AgentDefinition.delegatesTo}. A bare name is the awaited
 * delegation that has always existed; the object form is how an author says this one runs in the
 * background.
 */
export type AgentDelegation = string | { agent: string; detached?: boolean };

/**
 * Where a detached sub-agent run posts its answer: the thread that delegated it, and the
 * `agent`-kind tool call that started it. Carried on the child run's own {@link AgentRunInput},
 * because by the time the child finishes the parent turn is over and nothing is holding the
 * address.
 */
export interface DetachedDelivery {
  threadId: string;
  toolCallId: string;
}

/**
 * Declared shape of a tool.
 *  - `read`   auto-executes.
 *  - `action` never auto-executes — requires HITL approval.
 *  - `agent`  delegates to another named agent (durable: a child workflow; inline: a nested loop),
 *             handled at the loop level — NOT via a handler. Carries `targetAgent`.
 *  - `ask`    puts a question set to the user and waits for the answers (see `elicitation.ts`).
 *             Handled at the loop level and never registered, so no `ToolSpec` carries this kind:
 *             the only tool that has it is the built-in `ask`, whose definition the loop supplies.
 *  - `skill`  reads one of the procedures offered in the turn's `<skills>` catalog (see `skills.ts`).
 *             Auto-executes like a read and performs nothing, but is served by the LOOP from the
 *             catalog the journal holds rather than by a registered handler — so, like `ask`, no
 *             `ToolSpec` carries this kind.
 *  - `memory` records one fact about the actor for later turns (see `memory.ts`). Served by the LOOP
 *             and never registered, like `skill`. It WRITES, but auto-executes rather than asking
 *             for approval: an agent may only ever write the scope of the actor it is running for,
 *             so the blast radius of a bad one is the prompt of the person who was talking, and the
 *             remedy is the read-back that lets them delete it.
 */
export interface ToolSpec {
  name: string;
  kind: ToolKind;
  description: string;
  /**
   * Input schema as a [Standard Schema](https://standardschema.dev) — validation-agnostic, so
   * Zod, Valibot, or ArkType all work. The loop validates input via `~standard.validate` before
   * running the handler, and providers convert it to the model's tool-parameter JSON schema.
   */
  inputSchema: StandardSchemaV1;
  /** For `kind: 'agent'` — the name of the agent to delegate to. */
  targetAgent?: string;
  /**
   * For `kind: 'agent'` — start the delegation and let the calling turn END, instead of holding it
   * open until the delegate answers. The call's result is a {@link DetachedDelegationReceipt}, and
   * the answer arrives later as its own message in the same thread (see
   * {@link AgentRunInput.deliverTo}).
   *
   * Authored per EDGE, never chosen by the model: a model that can decide to detach can decide to
   * detach the one thing the user is sitting there waiting for, and it has no way to know which that
   * is. The person wiring `A -> B` does.
   *
   * Settled into the call's `persist:toolcall` checkpoint alongside `targetAgent`, so every replay
   * reads the branch back rather than re-deciding it against a registry that may have changed.
   */
  detached?: boolean;
  /** Roles allowed to invoke. Undefined → defaults applied by RolesPolicy (e.g. ADMIN-only). */
  roles?: string[];
  /**
   * Whether the tool exists in this deployment. `false` (or a predicate returning `false`) drops it
   * before the role filter, so it is never offered to the model and cannot be invoked. Undefined →
   * enabled.
   *
   * A predicate is re-evaluated every turn, so a flag flipped at runtime takes effect on the next
   * message with nothing re-registered. For availability that depends on injected services, put
   * `isEnabled()` on the handler instead — a spec is data, a handler is a provider.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /**
   * An authorization ability name (e.g. 'cache.purge'). Consumed by an ability-aware RolesPolicy
   * such as the `@dudousxd/nestjs-agent-authz` Gate adapter. Apps that don't use authz ignore it
   * and rely on `roles` instead — both live on the same SPI, so neither is required.
   */
  ability?: string;
}

/** What the model is told a tool looks like (no handler, no host types). */
export interface ToolDefinition {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: StandardSchemaV1;
}

/** A tool call the model asked for during a turn. */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
  /**
   * The tool's declared kind (`ToolSpec.kind`), stamped by the loop from the tool registry so
   * thread-read consumers know a call's kind without hardcoding a tool-name allowlist. Undefined
   * only for a call the loop couldn't resolve against the registry (defensively treated as `read`
   * wherever a definite value is required).
   */
  kind?: ToolKind;
}

/** Result of running a tool. */
export interface ToolResult {
  id: string;
  name: string;
  output: unknown;
  error?: string;
}

export interface MessageUsage {
  /**
   * Total input (prompt) tokens for the turn — the whole input side, cached and uncached alike.
   * `cacheWriteTokens` + `cacheReadTokens` are subsets of this count, not additions to it, so
   * token totals and quota never change when a breakdown is present.
   */
  inputTokens: number;
  /** Total output (completion) tokens for the turn; `reasoningTokens` is a subset of this. */
  outputTokens: number;
  /**
   * How many of `inputTokens` were written to the prompt cache this turn (billed at a premium,
   * ~1.25× base input). Undefined when the provider doesn't report caching. Refines the cost
   * estimate only — priced by the pricing row's cache-write rate (falling back to the input rate).
   */
  cacheWriteTokens?: number;
  /**
   * How many of `inputTokens` were served from the prompt cache this turn (billed at a discount,
   * ~0.1× base input). Undefined when the provider doesn't report caching.
   */
  cacheReadTokens?: number;
  /**
   * How many of `outputTokens` the model spent on reasoning/thinking. Observability only — reasoning
   * tokens are billed at the output rate, so they don't change the cost estimate. Undefined for
   * non-reasoning models or providers that don't report it.
   */
  reasoningTokens?: number;
  /**
   * This turn's USD cost: the provider's own reported figure when it has one, else an estimate from
   * the bound `AgentPricingStore` (cached once per run — see `AgentLoopDeps.pricingStore`), else
   * `null` when no pricing store is bound or the model has no price row. Never `0` for an unpriced
   * model — a real $0 turn and "we don't know" must stay distinguishable.
   */
  costUsd?: number | null;
}

/**
 * What a usage row was spent ON. `chat` is a model step of the turn itself; `follow_ups` is the
 * extra call that proposes follow-up questions; `history_summary` is the extra call a
 * {@link import('./spi/history-policy.js').HistoryPolicy} makes to fold windowed-out messages into a
 * summary — so bounding context cost never becomes spend nothing accounts for; `structured_output`
 * is the formatting pass that restates a finished answer as `AgentLoopDeps.outputSchema` requires.
 */
export type UsagePurpose = 'chat' | 'follow_ups' | 'history_summary' | 'structured_output';

export interface QuotaState {
  usedTokens: number;
  limitTokens: number;
  withinLimit: boolean;
}

/**
 * The read-model the quota-today endpoint returns to a client — a superset of {@link QuotaState}
 * for rendering a usage badge. `limitTokens` is `null` when no quota is configured (unlimited, so
 * `withinLimit` is always true); `costUsd` is the day's summed provider-reported USD spend (`0`
 * when only tokens were reported).
 */
export interface QuotaView {
  usedTokens: number;
  limitTokens: number | null;
  withinLimit: boolean;
  costUsd: number;
}

/**
 * Anything a human sends back into a parked run: a {@link Decision} on an action tool, or an
 * `ElicitationReply` answering a question set. Both travel the same `tool:<runId>:<toolCallId>`
 * signal, so the runner that delivers them does not need to know which it is carrying.
 */
export type HumanReply = Decision | ElicitationReply;

/** A human decision on a pending action tool call. */
export interface Decision {
  approved: boolean;
  reason?: string;
  /**
   * Opaque ref of WHO decided (e.g. a console admin). When absent, the run's own actor decided
   * (the chat flow).
   */
  executedByRef?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * A file a user attached to a message so a vision-capable model sees it natively (an image, a PDF).
 * The lib stays provider-agnostic: it passes {@link MessageAttachment.url} straight through as the
 * model's image/file part data — making that URL reachable by the provider (presigned S3, a proxy)
 * is the consumer's job. The lib never fetches bytes or talks to a store.
 */
export interface MessageAttachment {
  /** Stable id of the stored media object in the consumer's media store. Provenance + replay key. */
  mediaId: string;
  /** A URL the model provider can fetch the bytes from at turn time. */
  url: string;
  /** MIME type — routes the part: `image/*` → image part, otherwise → file part. */
  contentType: string;
  /** Original filename, for display and the file part's filename. */
  name: string;
}

/** A neutral chat message exchanged with the model. */
export interface ModelMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  /** User-message attachments (image/PDF), rendered as native model content parts by the adapter. */
  attachments?: MessageAttachment[];
}

export interface PageContext {
  kind?: string;
  [key: string]: unknown;
}

/**
 * Inputs a {@link PromptBuilder} or {@link PromptContributor} may use to compose the system prompt
 * for a turn. Resolved once per turn from stable inputs (actor / agent / pageContext) so it stays
 * replay-safe.
 */
export interface PromptContext {
  actor: Actor;
  /** The selected agent's name. */
  agentName: string;
  pageContext?: PageContext;
}

/**
 * An agent's base system prompt. Return a string (optionally async) built from the turn's context —
 * e.g. injecting the actor, the current page, or a data-shape description. Set on an `@Agent` class
 * via a `@SystemPrompt()` method (or a flat string).
 */
export type PromptBuilder = (ctx: PromptContext) => string | Promise<string>;

/**
 * A cross-agent system-prompt contributor. Returns an ordered section to APPEND to the composed
 * prompt (after the agent's base), or `null` to contribute nothing this turn — so conditional
 * sections (base-scope, a mentions legend, schema hints) stay clean when they don't apply.
 * Registered app-wide via `@SystemPromptContributor()`; the loop runs every contributor in order.
 */
export type PromptContributor = (ctx: PromptContext) => string | null | Promise<string | null>;

/** Everything needed to run one agent turn. */
export interface AgentRunInput {
  threadId: string;
  actor: Actor;
  /** The latest user message text. */
  userText: string;
  /** Files attached to the latest user message (image/PDF). Persisted with it and sent to the model. */
  attachments?: MessageAttachment[];
  pageContext?: PageContext;
  /** YYYY-MM-DD stamped by the runner so quota/day stays deterministic under durable replay. */
  day?: string;
  /** Which named agent runs this turn. Omitted → the default/single agent. */
  agentName?: string;
  /**
   * How many agent→agent delegations deep this run already is (0 for a top-level turn). The runner
   * increments it for each child run; the loop refuses to delegate past {@link MAX_DELEGATION_DEPTH}.
   */
  delegationDepth?: number;
  /**
   * When set, this run streams into ANOTHER run's sink instead of its own. A sub-agent run carries
   * its top-level ancestor's runId here so its tokens (and its pending action-tool frames) land in
   * the live stream the human is already watching — the only way a human can see, and therefore
   * approve, a sub-agent's HITL action. Propagated unchanged down the delegation chain.
   */
  sinkRunId?: string;
  /**
   * Set on a DETACHED sub-agent run: the thread and tool call this run answers into when it
   * finishes. Its presence is also what makes a run detached from the inside — it has no ancestor
   * sink to stream into, so nothing else distinguishes it from a top-level turn.
   */
  deliverTo?: DetachedDelivery;
  /**
   * The run that started this one (a delegation's parent). Recorded with the run so a governance
   * surface can roll a delegation's cost up to the turn that asked for it; a detached child is
   * otherwise a row with nothing pointing at it.
   */
  parentRunId?: string;
  /**
   * Re-run the last exchange instead of adding a new message: the loop truncates everything after
   * the thread's last user message and re-answers it (no `userText` is appended). Used by a
   * "regenerate" button. `userText` is ignored when set.
   */
  regenerate?: boolean;
}

/**
 * A named agent: its prompt, the tools it may use, and who it can hand off to. This is the
 * internal record the loop and `AgentDepsFactory` consume; in an app it is authored as an
 * `@Agent`-decorated class and populated into the `AgentRegistry` by discovery (name, base prompt
 * from `@SystemPrompt`, tool allow-list, handoff targets). An orchestrator hands off to others via
 * `ctx.handoff(OtherAgent)`. Model/store/sink/governance are shared from the module.
 */
export interface AgentDefinition {
  name: string;
  /** Human-readable summary from `@Agent({ description })`. Surfaced by the `GET agents` catalog. */
  description?: string;
  /** Base prompt for this agent. A flat string, or a {@link PromptBuilder} resolved per turn. */
  systemPrompt?: string | PromptBuilder;
  /** Allow-list of tool names this agent may use (subset of all registered tools). */
  tools?: string[];
  /**
   * Other agents this agent may hand off to (auto-registered as `agent`-kind tools). A bare name
   * is the awaited form; `{ agent, detached: true }` starts the delegate and lets this agent's turn
   * finish without its answer — see {@link ToolSpec.detached}.
   */
  delegatesTo?: AgentDelegation[];
  modelId?: string;
  maxSteps?: number;
  /**
   * This agent's own ceiling on how much of a thread rides into its turn, overriding the
   * module-wide one. A persona that reasons over a long back-and-forth and one that answers a single
   * question from a page context want very different windows.
   */
  history?: AgentHistoryWindow;
  /**
   * Constrain this agent's final answer to a schema. A live schema INSTANCE, so it is resolved from
   * DI on whichever process runs the turn and never travels on `AgentRunInput` — a Standard Schema
   * cannot survive the JSON hop into a durable workflow, which is why there is no per-request
   * override on the HTTP surface.
   */
  outputSchema?: StandardSchemaV1;
  /**
   * Extra model calls allowed to fix an answer that failed {@link outputSchema}. Undefined → 1.
   */
  outputRepairAttempts?: number;
  /**
   * Questions this agent puts to the user BEFORE it starts working. Authored, so the turn pays no
   * model call to produce them and a client knows the total up front. Undefined → no intake.
   */
  intake?: AgentIntake;
  /**
   * Whether this agent is offered the built-in `ask` tool. Undefined → the module-wide setting.
   */
  ask?: boolean;
}

/**
 * The read-model the `GET agents` endpoint returns to a client — the safe public subset of an
 * {@link AgentDefinition} so a host can render a persona picker instead of hardcoding one.
 */
export interface AgentCatalogEntry {
  name: string;
  description: string;
  /** Whether this is the agent a turn uses when the caller names none. Omitted when not the default. */
  isDefault?: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  /**
   * The agent a `chat()` call on this thread uses when the caller doesn't name one explicitly.
   * Optional — undefined for a store that doesn't implement `AgentStore.updateThread` (the only
   * way to set it). The REST/service read-model normalizes this to `null` when absent.
   */
  defaultAgent?: string | null;
  /**
   * The runId of a currently-running turn on this thread, or `null` if none is running. Optional —
   * undefined for a store that doesn't implement `AgentStore.activeRunForThread`. The REST/service
   * read-model normalizes this to `null` when absent, so a client can always do `?? null`.
   */
  activeRunId?: string | null;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Which agent produced this message (assistant messages) — provenance for replay / UI / telescope. */
  agentName?: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  /** Files the user attached to this message (image/PDF). Persisted with the message, replayed as-is. */
  attachments?: MessageAttachment[];
  followUps?: string[];
  usage?: MessageUsage;
  /** The run (turn) that produced this message; absent on a row written before this was recorded. */
  runId?: string;
  createdAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: StoredMessage[];
  activeStreamId?: string;
}

export type ToolCallStatus =
  | 'auto_executed'
  | 'pending_approval'
  | 'executed'
  | 'rejected'
  | 'failed';

/**
 * Serializable input for a dispatched model-turn step. Carries only data — the serving worker
 * re-resolves the model/sink/registry from its own DI via AGENT_DEPS_FACTORY.forAgent(agentName).
 */
export interface LlmStepEnvelope {
  /** Undefined = default agent (same semantics as {@link AgentRunInput.agentName}). */
  agentName?: string;
  system: string;
  messages: ModelMessage[];
  /** The turn's actor — the handler re-derives tool definitions from it (definitionsFor). */
  actor: Actor;
  /**
   * Hold this call's stream frames rather than writing them to the run's sink, and return them on
   * the result. Set by the loop when an output processor has to see the whole answer before the
   * subscriber does — the dispatched handler streams to a worker-side sink the loop cannot
   * interpose on, so the instruction has to ride the envelope. Absent → stream live, as before.
   */
  bufferOutput?: boolean;
}

/**
 * The serializable subset of `AiToolCtx` — everything except `host` (re-attached handler-side
 * from DI).
 */
export interface ToolStepCtx {
  actor: Actor;
  threadId: string;
  runId: string;
  requestId: string;
  agentName?: string;
  pageContext?: PageContext;
}

/** Serializable input for a dispatched tool-execution step. */
export interface ToolStepEnvelope {
  toolName: string;
  input: unknown;
  ctx: ToolStepCtx;
  /** Applied INSIDE the handler (`withToolTimeout`) — never as a durable step `timeoutMs`. */
  timeoutMs?: number;
  /**
   * The numeric half of `toolTransientRetry` (resolved by the loop from `AgentLoopDeps`, always a
   * definite value — `false` when disabled, else concrete `{ attempts, backoffMs }` with defaults
   * already filled in) — never `undefined`, so the dispatched handler gets the SAME policy the
   * loop would have used locally. The `classify` function is deliberately absent: it isn't
   * wire-safe, so the handler resolves its own from its local module options (see
   * `AgentRunSteps.tool`) instead of trying to serialize a function.
   */
  transientRetry: ToolTransientRetryNumbers | false;
}
