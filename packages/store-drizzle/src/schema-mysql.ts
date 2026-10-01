import type {
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
import {
  bigint,
  boolean,
  datetime,
  double,
  index,
  int,
  json,
  longtext,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { AgentRunStatus, RagIngestionStatus } from './schema.js';

/**
 * The agent tables for MySQL (8.0+) — the same tables, columns and JS property names as the SQLite
 * {@link import('./schema.js').agentSchema}, in MySQL types: `json` for the JSON columns,
 * `datetime(3)` for the timestamps (UTC, read back as `Date` — MySQL's bare `datetime` is whole
 * seconds), `longtext` for anything a model or a stack trace can make long (`text` stops at 64 KB),
 * `varchar(255)` for keys and short labels (an index needs a bounded column), `bigint` for the
 * epoch-ms counters, `double` for prices and costs. `ensureAgentSchema` creates the tables
 * `utf8mb4_bin`, so ids and actor refs compare case-sensitively, as on Postgres and SQLite. Pass it to
 * `drizzle(pool, { schema: mysqlAgentSchema, mode: 'default' })`.
 */
const ts = (name: string) => datetime(name, { mode: 'date', fsp: 3 });
/** A key or short label: bounded, so it can be indexed. */
const key = (name: string) => varchar(name, { length: 255 });

export const agentThread = mysqlTable(
  'agent_thread',
  {
    id: key('id').primaryKey(),
    actorRef: key('actor_ref').notNull(),
    tenantRef: key('tenant_ref'),
    title: key('title').notNull(),
    transient: boolean('transient').notNull().default(false),
    activeStreamId: key('active_stream_id'),
    defaultAgent: key('default_agent'),
    model: key('model'),
    /** The persona a send on this thread runs under when it names none; `null` → the agent's default. */
    persona: key('persona'),
    queuePause: json('queue_pause').$type<QueuePause>(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
  },
  (table) => [index('agent_thread_actor_updated_idx').on(table.actorRef, table.updatedAt)],
);

export const agentMessage = mysqlTable(
  'agent_message',
  {
    id: key('id').primaryKey(),
    threadId: key('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    role: key('role').$type<MessageRole>().notNull(),
    content: longtext('content').notNull(),
    toolCalls: json('tool_calls').$type<ToolCallRequest[]>(),
    toolResults: json('tool_results').$type<ToolResult[]>(),
    attachments: json('attachments').$type<MessageAttachment[]>(),
    followUps: json('follow_ups').$type<string[]>(),
    usage: json('usage').$type<MessageUsage>(),
    agentName: key('agent_name'),
    /** The persona the turn that wrote this message ran under; `null` → none. */
    persona: key('persona'),
    runId: key('run_id'),
    reasoning: longtext('reasoning'),
    reasoningMs: int('reasoning_ms'),
    ui: json('ui').$type<AgentUiComponent[]>(),
    feedback: json('feedback').$type<MessageFeedback>(),
    seq: int('seq'),
    createdAt: ts('created_at').notNull(),
  },
  (table) => [index('agent_message_thread_created_idx').on(table.threadId, table.createdAt)],
);

export const agentToolCall = mysqlTable(
  'agent_tool_call',
  {
    id: key('id').primaryKey(),
    messageId: key('message_id')
      .notNull()
      .references(() => agentMessage.id, { onDelete: 'cascade' }),
    toolName: key('tool_name').notNull(),
    toolType: key('tool_type').$type<ToolKind>().notNull(),
    input: json('input'),
    output: json('output'),
    status: key('status').$type<ToolCallStatus>().notNull(),
    executedByRef: key('executed_by_ref'),
    executionMs: int('execution_ms'),
    error: longtext('error'),
    createdAt: ts('created_at').notNull(),
    executedAt: ts('executed_at'),
    runId: key('run_id'),
    confirmation: json('confirmation').$type<ToolConfirmation>(),
    approver: key('approver'),
    expiresAt: ts('expires_at'),
    remember: boolean('remember'),
    decidedVia: key('decided_via'),
  },
  (table) => [index('agent_tool_call_message_idx').on(table.messageId)],
);

export const agentQueuedMessage = mysqlTable(
  'agent_queued_message',
  {
    id: key('id').primaryKey(),
    threadId: key('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actor: json('actor').$type<Actor>().notNull(),
    content: longtext('content').notNull(),
    attachments: json('attachments').$type<MessageAttachment[]>(),
    agentName: key('agent_name'),
    /** The persona the send resolved — what the message starts under. */
    persona: key('persona'),
    model: key('model'),
    pageContext: json('page_context').$type<PageContext>(),
    interrupt: boolean('interrupt').notNull().default(false),
    position: int('position').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [index('agent_queued_message_thread_position_idx').on(table.threadId, table.position)],
);

export const agentTokenUsage = mysqlTable(
  'agent_token_usage',
  {
    id: key('id').primaryKey(),
    threadId: key('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actorRef: key('actor_ref').notNull(),
    messageId: key('message_id'),
    modelId: key('model_id').notNull(),
    purpose: key('purpose').$type<UsagePurpose>().notNull(),
    inputTokens: int('input_tokens').notNull(),
    outputTokens: int('output_tokens').notNull(),
    cacheWriteTokens: int('cache_write_tokens'),
    cacheReadTokens: int('cache_read_tokens'),
    costUsd: double('cost_usd'),
    createdAt: ts('created_at').notNull(),
  },
  (table) => [index('agent_token_usage_actor_created_idx').on(table.actorRef, table.createdAt)],
);

export const agentModelPricing = mysqlTable('agent_model_pricing', {
  id: key('id').primaryKey(),
  modelId: key('model_id').notNull(),
  inputPricePer1m: double('input_price_per_1m').notNull(),
  outputPricePer1m: double('output_price_per_1m').notNull(),
  cacheWritePricePer1m: double('cache_write_price_per_1m'),
  cacheReadPricePer1m: double('cache_read_price_per_1m'),
  effectiveFrom: ts('effective_from').notNull(),
  isCurrent: boolean('is_current').notNull(),
});

export const agentRun = mysqlTable(
  'agent_run',
  {
    id: key('id').primaryKey(),
    threadId: key('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actorRef: key('actor_ref').notNull(),
    agentName: key('agent_name'),
    status: key('status').$type<AgentRunStatus>().notNull(),
    durationMs: int('duration_ms'),
    errorCode: key('error_code'),
    errorMessage: longtext('error_message'),
    retries: int('retries').notNull().default(0),
    startedAt: ts('started_at').notNull(),
    settledAt: ts('settled_at'),
    promptHash: key('prompt_hash'),
    parentRunId: key('parent_run_id'),
  },
  (table) => [index('agent_run_started_idx').on(table.startedAt)],
);

export const agentMemory = mysqlTable(
  'agent_memory',
  {
    id: key('id').primaryKey(),
    scope: key('scope').notNull(),
    key: key('key').notNull(),
    text: longtext('text').notNull(),
    originAuthor: key('origin_author').$type<MemoryOrigin['author']>().notNull(),
    originThreadId: key('origin_thread_id'),
    originRunId: key('origin_run_id'),
    originActorRef: key('origin_actor_ref'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [uniqueIndex('agent_memory_scope_key_uq').on(table.scope, table.key)],
);

export const ragIngestionLog = mysqlTable(
  'rag_ingestion_log',
  {
    documentId: key('document_id').primaryKey(),
    status: key('status').$type<RagIngestionStatus>().notNull(),
    collection: key('collection'),
    ownerType: key('owner_type'),
    ownerId: key('owner_id'),
    source: longtext('source'),
    mimeType: key('mime_type'),
    size: bigint('size', { mode: 'number' }),
    chunks: int('chunks'),
    reason: key('reason'),
    error: longtext('error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [index('rag_ingestion_log_collection_idx').on(table.collection, table.updatedAt)],
);

export const agentConfirmToken = mysqlTable(
  'agent_confirm_token',
  {
    hash: key('hash').primaryKey(),
    actorRef: key('actor_ref').notNull(),
    tool: key('tool').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('agent_confirm_token_expires_idx').on(table.expiresAt)],
);

export const agentStreamFrame = mysqlTable(
  'agent_stream_frame',
  {
    runId: key('run_id').notNull(),
    seq: int('seq').notNull(),
    frame: longtext('frame'),
    error: longtext('error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

/** Every agent table, for `drizzle(pool, { schema: mysqlAgentSchema, mode: 'default' })` on MySQL. */
export const mysqlAgentSchema = {
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
