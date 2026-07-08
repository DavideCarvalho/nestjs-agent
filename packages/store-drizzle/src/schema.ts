import type {
  MessageRole,
  MessageUsage,
  ToolCallRequest,
  ToolCallStatus,
  ToolKind,
  ToolResult,
  UsagePurpose,
} from '@dudousxd/nestjs-agent-core';
import {
  type BaseSQLiteDatabase,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema mirroring the MikroORM agent entities (same logical columns/relations):
 * threads, messages, tool calls, token usage and model pricing. Targets the SQLite core so the
 * db-test runs on an in-memory better-sqlite3; timestamps are stored as integer epoch-ms columns
 * (`{ mode: 'timestamp_ms' }`) which Drizzle round-trips to/from JS `Date`, and the model-facing
 * message extras (tool calls/results, follow-ups, usage) live in JSON `text` columns.
 */

/**
 * A conversation thread. `deletedAt` drives soft delete: a deleted thread is hidden from
 * {@link import('./drizzle-agent-store.js').DrizzleAgentStore.getThread}/`listThreads` but its
 * row survives.
 */
export const agentThread = sqliteTable(
  'agent_thread',
  {
    id: text('id').primaryKey(),
    actorRef: text('actor_ref').notNull(),
    tenantRef: text('tenant_ref'),
    title: text('title').notNull(),
    persona: text('persona').notNull().default('default'),
    transient: integer('transient', { mode: 'boolean' }).notNull().default(false),
    activeStreamId: text('active_stream_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('agent_thread_actor_updated_idx').on(table.actorRef, table.updatedAt)],
);

/**
 * One stored message in a thread. The model-facing extras (`toolCalls`/`toolResults`/
 * `followUps`/`usage`) are folded into nullable JSON columns so a single row round-trips to a
 * {@link import('@dudousxd/nestjs-agent-core').StoredMessage}. `threadId` cascades on delete.
 */
export const agentMessage = sqliteTable(
  'agent_message',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull(),
    toolCalls: text('tool_calls', { mode: 'json' }).$type<ToolCallRequest[]>(),
    toolResults: text('tool_results', { mode: 'json' }).$type<ToolResult[]>(),
    followUps: text('follow_ups', { mode: 'json' }).$type<string[]>(),
    usage: text('usage', { mode: 'json' }).$type<MessageUsage>(),
    persona: text('persona'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('agent_message_thread_created_idx').on(table.threadId, table.createdAt)],
);

/** A tool call requested during an assistant turn. The pk is the model-supplied `toolCallId`. */
export const agentToolCall = sqliteTable('agent_tool_call', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => agentMessage.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  toolType: text('tool_type').$type<ToolKind>().notNull(),
  input: text('input', { mode: 'json' }),
  output: text('output', { mode: 'json' }),
  status: text('status').$type<ToolCallStatus>().notNull(),
  executedByRef: text('executed_by_ref'),
  executionMs: integer('execution_ms'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  executedAt: integer('executed_at', { mode: 'timestamp_ms' }),
});

/** A token-usage ledger row, summed per actor per day by `quotaToday`. */
export const agentTokenUsage = sqliteTable(
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
    /** Subset of `inputTokens` written to the prompt cache this turn; null when not reported. */
    cacheWriteTokens: integer('cache_write_tokens'),
    /** Subset of `inputTokens` served from the prompt cache this turn; null when not reported. */
    cacheReadTokens: integer('cache_read_tokens'),
    /** Provider-reported actual USD cost for the turn; null when only tokens were reported. */
    costUsd: real('cost_usd'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('agent_token_usage_actor_created_idx').on(table.actorRef, table.createdAt)],
);

/** Per-model token pricing, versioned by `effectiveFrom`; `isCurrent` flags the live row. */
export const agentModelPricing = sqliteTable('agent_model_pricing', {
  id: text('id').primaryKey(),
  modelId: text('model_id').notNull(),
  inputPricePer1m: real('input_price_per_1m').notNull(),
  outputPricePer1m: real('output_price_per_1m').notNull(),
  /** Per-1M price for cache-write input tokens; null → price them at the input rate. */
  cacheWritePricePer1m: real('cache_write_price_per_1m'),
  /** Per-1M price for cache-read input tokens; null → price them at the input rate. */
  cacheReadPricePer1m: real('cache_read_price_per_1m'),
  effectiveFrom: integer('effective_from', { mode: 'timestamp_ms' }).notNull(),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull(),
});

/** The five agent tables as one schema object, ready for `drizzle(client, { schema })`. */
export const agentSchema = {
  agentThread,
  agentMessage,
  agentToolCall,
  agentTokenUsage,
  agentModelPricing,
};

/**
 * The dialect-portable Drizzle SQLite database handle the store operates on. Accepts any SQLite
 * driver (better-sqlite3, libsql, D1, …) in either sync or async result mode; the host app owns
 * the connection and passes the `drizzle(...)` instance in.
 */
export type AgentDrizzleDb = BaseSQLiteDatabase<'sync' | 'async', unknown>;

/** A persisted thread row as Drizzle selects it. */
export type AgentThreadRow = typeof agentThread.$inferSelect;
/** A persisted message row as Drizzle selects it. */
export type AgentMessageRow = typeof agentMessage.$inferSelect;
