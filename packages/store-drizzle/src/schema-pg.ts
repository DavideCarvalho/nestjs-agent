import { canonicalActionProposalJson } from '@dudousxd/nestjs-agent-core';
import type {
  ActionProposal,
  Actor,
  AgentUiComponent,
  MemoryOrigin,
  MessageAttachment,
  MessageFeedback,
  MessageRole,
  MessageUsage,
  PageContext,
  QueuePause,
  ToolCallRequest,
  ToolCallStatus,
  ToolConfirmation,
  ToolKind,
  ToolResult,
  UsagePurpose,
} from '@dudousxd/nestjs-agent-core';
import type { UiCapabilities } from '@dudousxd/nestjs-agent-core/genui';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AgentRunStatus, RagIngestionStatus } from './schema.js';

/**
 * The agent tables for Postgres — the same tables, columns and JS property names as the SQLite
 * {@link import('./schema.js').agentSchema}, in Postgres types: `jsonb` for the JSON columns,
 * `timestamptz(3)` for the timestamps (read back as `Date`), `bigint` for the epoch-ms counters,
 * `double precision` for prices and costs. Pass it to `drizzle(pool, { schema: pgAgentSchema })`;
 * every store in this package finds these tables from the handle, whichever schema it was built with.
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });

export const agentThread = pgTable(
  'agent_thread',
  {
    id: text('id').primaryKey(),
    actorRef: text('actor_ref').notNull(),
    tenantRef: text('tenant_ref'),
    title: text('title').notNull(),
    transient: boolean('transient').notNull().default(false),
    activeStreamId: text('active_stream_id'),
    defaultAgent: text('default_agent'),
    model: text('model'),
    /** The persona a send on this thread runs under when it names none; `null` → the agent's default. */
    persona: text('persona'),
    queuePause: jsonb('queue_pause').$type<QueuePause>(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
  },
  (table) => [index('agent_thread_actor_updated_idx').on(table.actorRef, table.updatedAt)],
);

export const agentMessage = pgTable(
  'agent_message',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    actionProposalOutcome: text('action_proposal_outcome'),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls').$type<ToolCallRequest[]>(),
    toolResults: jsonb('tool_results').$type<ToolResult[]>(),
    attachments: jsonb('attachments').$type<MessageAttachment[]>(),
    followUps: jsonb('follow_ups').$type<string[]>(),
    usage: jsonb('usage').$type<MessageUsage>(),
    agentName: text('agent_name'),
    /** The persona the turn that wrote this message ran under; `null` → none. */
    persona: text('persona'),
    runId: text('run_id'),
    reasoning: text('reasoning'),
    reasoningMs: integer('reasoning_ms'),
    ui: jsonb('ui').$type<AgentUiComponent[]>(),
    feedback: jsonb('feedback').$type<MessageFeedback>(),
    seq: integer('seq'),
    createdAt: ts('created_at').notNull(),
  },
  (table) => [index('agent_message_thread_created_idx').on(table.threadId, table.createdAt)],
);

export const agentToolCall = pgTable(
  'agent_tool_call',
  {
    proposalId: text('proposal_id'),
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => agentMessage.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolType: text('tool_type').$type<ToolKind>().notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    status: text('status').$type<ToolCallStatus>().notNull(),
    executedByRef: text('executed_by_ref'),
    executionMs: integer('execution_ms'),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    executedAt: ts('executed_at'),
    runId: text('run_id'),
    confirmation: jsonb('confirmation').$type<ToolConfirmation>(),
    approver: text('approver'),
    expiresAt: ts('expires_at'),
    remember: boolean('remember'),
    decidedVia: text('decided_via'),
  },
  (table) => [index('agent_tool_call_message_idx').on(table.messageId)],
);

export const agentQueuedMessage = pgTable(
  'agent_queued_message',
  {
    uiCapabilities: jsonb('ui_capabilities').$type<UiCapabilities>(),
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actor: jsonb('actor').$type<Actor>().notNull(),
    content: text('content').notNull(),
    attachments: jsonb('attachments').$type<MessageAttachment[]>(),
    agentName: text('agent_name'),
    /** The persona the send resolved — what the message starts under. */
    persona: text('persona'),
    model: text('model'),
    pageContext: jsonb('page_context').$type<PageContext>(),
    interrupt: boolean('interrupt').notNull().default(false),
    position: integer('position').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [index('agent_queued_message_thread_position_idx').on(table.threadId, table.position)],
);

export const agentTokenUsage = pgTable(
  'agent_token_usage',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actorRef: text('actor_ref').notNull(),
    messageId: text('message_id'),
    modelId: text('model_id').notNull(),
    purpose: text('purpose').$type<UsagePurpose>().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    costUsd: doublePrecision('cost_usd'),
    createdAt: ts('created_at').notNull(),
  },
  (table) => [index('agent_token_usage_actor_created_idx').on(table.actorRef, table.createdAt)],
);

export const agentModelPricing = pgTable('agent_model_pricing', {
  id: text('id').primaryKey(),
  modelId: text('model_id').notNull(),
  inputPricePer1m: doublePrecision('input_price_per_1m').notNull(),
  outputPricePer1m: doublePrecision('output_price_per_1m').notNull(),
  cacheWritePricePer1m: doublePrecision('cache_write_price_per_1m'),
  cacheReadPricePer1m: doublePrecision('cache_read_price_per_1m'),
  effectiveFrom: ts('effective_from').notNull(),
  isCurrent: boolean('is_current').notNull(),
});

export const agentRun = pgTable(
  'agent_run',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actorRef: text('actor_ref').notNull(),
    agentName: text('agent_name'),
    status: text('status').$type<AgentRunStatus>().notNull(),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retries: integer('retries').notNull().default(0),
    startedAt: ts('started_at').notNull(),
    settledAt: ts('settled_at'),
    promptHash: text('prompt_hash'),
    parentRunId: text('parent_run_id'),
  },
  (table) => [index('agent_run_started_idx').on(table.startedAt)],
);

export const agentMemory = pgTable(
  'agent_memory',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    text: text('text').notNull(),
    originAuthor: text('origin_author').$type<MemoryOrigin['author']>().notNull(),
    originThreadId: text('origin_thread_id'),
    originRunId: text('origin_run_id'),
    originActorRef: text('origin_actor_ref'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [uniqueIndex('agent_memory_scope_key_uq').on(table.scope, table.key)],
);

export const ragIngestionLog = pgTable(
  'rag_ingestion_log',
  {
    documentId: text('document_id').primaryKey(),
    status: text('status').$type<RagIngestionStatus>().notNull(),
    collection: text('collection'),
    ownerType: text('owner_type'),
    ownerId: text('owner_id'),
    source: text('source'),
    mimeType: text('mime_type'),
    size: bigint('size', { mode: 'number' }),
    chunks: integer('chunks'),
    reason: text('reason'),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [index('rag_ingestion_log_collection_idx').on(table.collection, table.updatedAt)],
);

export const agentConfirmToken = pgTable(
  'agent_confirm_token',
  {
    hash: text('hash').primaryKey(),
    actorRef: text('actor_ref').notNull(),
    tool: text('tool').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('agent_confirm_token_expires_idx').on(table.expiresAt)],
);

export const agentStreamFrame = pgTable(
  'agent_stream_frame',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    frame: text('frame'),
    error: text('error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

/** JSON text preserves valid JSON strings that a native JSON column cannot represent. */
const proposalJson = customType<{ data: ActionProposal; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => canonicalActionProposalJson(value),
  fromDriver: (value) => JSON.parse(value) as ActionProposal,
});

/** Independent action proposals; decision and execution work commit in one fenced row. */
export const agentActionProposal = pgTable(
  'agent_action_proposal',
  {
    id: text('id').primaryKey(),
    scopeKey: text('scope_key').notNull(),
    decision: text('decision').$type<ActionProposal['decision']>().notNull(),
    logicalSort: text('logical_sort').notNull(),
    createFingerprint: text('create_fingerprint').notNull(),
    proposal: proposalJson('proposal').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    executionStatus:
      text('execution_status').$type<NonNullable<ActionProposal['execution']>['status']>(),
    leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
    deliveryStatus: text('delivery_status'),
    deliveryLeaseExpiresAt: bigint('delivery_lease_expires_at', { mode: 'number' }),
    replacementGroupKey: text('replacement_group_key'),
    outcomeIdKey: text('outcome_id_key'),
    proposalExpiresAt: bigint('proposal_expires_at', { mode: 'number' }),
    discoveryIndexVersion: bigint('discovery_index_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('agent_action_proposal_execution_idx').on(
      table.discoveryIndexVersion,
      table.executionStatus,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    index('agent_action_proposal_expiry_idx').on(
      table.discoveryIndexVersion,
      table.decision,
      table.proposalExpiresAt,
      table.createdAt,
    ),
    index('agent_action_proposal_replacement_idx').on(
      table.scopeKey,
      table.replacementGroupKey,
      table.decision,
    ),
    index('agent_action_proposal_delivery_idx').on(
      table.deliveryStatus,
      table.deliveryLeaseExpiresAt,
      table.createdAt,
    ),
    uniqueIndex('agent_action_proposal_outcome_idx').on(table.outcomeIdKey),
    index('agent_action_proposal_scope_idx').on(table.scopeKey, table.createdAt, table.id),
  ],
);

/** Every agent table, for `drizzle(pool, { schema: pgAgentSchema })` on Postgres. */
export const pgAgentSchema = {
  agentActionProposal,
  agentThread,
  agentMessage,
  agentQueuedMessage,
  agentToolCall,
  agentTokenUsage,
  agentModelPricing,
  agentRun,
  agentMemory,
  ragIngestionLog,
  agentConfirmToken,
  agentStreamFrame,
};
