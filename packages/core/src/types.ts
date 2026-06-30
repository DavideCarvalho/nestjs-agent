import type { ZodType } from 'zod';

/** Who is driving the turn. Roles + tenant come from the host app (nestjs-context/authz). */
export interface Actor {
  id: string;
  role?: string;
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
  inputSchema: ZodType;
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
  inputSchema: ZodType;
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
  inputTokens: number;
  outputTokens: number;
}

export type UsagePurpose = 'chat' | 'title' | 'follow_ups' | 'summary';

export interface QuotaState {
  usedTokens: number;
  limitTokens: number;
  withinLimit: boolean;
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

export interface Persona {
  id: string;
  label: string;
  systemPrompt: string;
  /** If set, only these tool names are offered (after role filtering). */
  allowedTools?: string[];
}

export interface PageContext {
  kind?: string;
  [key: string]: unknown;
}

/** Everything needed to run one agent turn. */
export interface AgentRunInput {
  threadId: string;
  actor: Actor;
  /** The latest user message text. */
  userText: string;
  persona?: Persona;
  pageContext?: PageContext;
  isRegenerate?: boolean;
  /** YYYY-MM-DD stamped by the runner so quota/day stays deterministic under durable replay. */
  day?: string;
  /** Which named agent runs this turn. Omitted → the default/single agent. */
  agentName?: string;
}

/**
 * A named agent: its prompt, the tools it may use, and its personas. Multiple definitions are
 * registered via `AgentModule.forFeature([...])`; an orchestrator delegates to others through
 * `ctx.runAgent(name, task)`. Model/store/sink/governance are shared from the module unless
 * overridden here.
 */
export interface AgentDefinition {
  name: string;
  systemPrompt?: string;
  /** Allow-list of tool names this agent may use (subset of all registered tools). */
  tools?: string[];
  /** Names of other agents this agent may delegate to (auto-registered as `agent`-kind tools). */
  delegatesTo?: string[];
  personas?: Persona[];
  defaultPersona?: string;
  modelId?: string;
  maxSteps?: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  persona: string;
  pinnedAt?: string;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
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
