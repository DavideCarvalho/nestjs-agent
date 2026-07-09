import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Who is driving the turn. Roles + tenant come from the host app (nestjs-context/authz). */
export interface Actor {
  id: string;
  /** The caller's roles. Tool authorization is a set intersection against a tool's `roles`. */
  roles?: string[];
  tenantRef?: string;
}

export type ToolKind = 'read' | 'action' | 'agent';

/**
 * Declared shape of a tool.
 *  - `read`   auto-executes.
 *  - `action` never auto-executes — requires HITL approval.
 *  - `agent`  delegates to another named agent (durable: a child workflow; inline: a nested loop),
 *             handled at the loop level — NOT via a handler. Carries `targetAgent`.
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
  /** Roles allowed to invoke. Undefined → defaults applied by RolesPolicy (e.g. ADMIN-only). */
  roles?: string[];
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
}

export type UsagePurpose = 'chat' | 'follow_ups';

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

/** A human decision on a pending action tool call. */
export interface Decision {
  approved: boolean;
  reason?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

/** A neutral chat message exchanged with the model. */
export interface ModelMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
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
  /** Base prompt for this agent. A flat string, or a {@link PromptBuilder} resolved per turn. */
  systemPrompt?: string | PromptBuilder;
  /** Allow-list of tool names this agent may use (subset of all registered tools). */
  tools?: string[];
  /** Names of other agents this agent may hand off to (auto-registered as `agent`-kind tools). */
  delegatesTo?: string[];
  modelId?: string;
  maxSteps?: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Which agent produced this message (assistant messages) — provenance for replay / UI / telescope. */
  agentName?: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  followUps?: string[];
  usage?: MessageUsage;
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
