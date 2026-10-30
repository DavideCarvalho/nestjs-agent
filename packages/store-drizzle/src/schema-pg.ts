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
import type {
  AgentHostContext,
  CostSource,
  GenuiErrorCategory,
  GenuiToolMarker,
  GenuiValidity,
  RecordGenuiCallInput,
  RunStepTiming,
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
  varchar,
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
  (table) => [
    index('agent_thread_actor_updated_idx').on(table.actorRef, table.updatedAt),
    // `ownerOfActiveStream` reads by run id on every stream attach and reconnect.
    index('agent_thread_active_stream_idx').on(table.activeStreamId),
  ],
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
  (table) => [
    index('agent_message_thread_created_idx').on(table.threadId, table.createdAt),
    // Transcript reads order a thread's messages by `seq`.
    index('agent_message_thread_seq_idx').on(table.threadId, table.seq),
  ],
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
  (table) => [
    index('agent_tool_call_message_idx').on(table.messageId),
    // The approvals inbox: `pending_approval`, oldest first.
    index('agent_tool_call_status_created_idx').on(table.status, table.createdAt),
    index('agent_tool_call_run_idx').on(table.runId),
    index('agent_tool_call_created_idx').on(table.createdAt),
  ],
);

export const agentQueuedMessage = pgTable(
  'agent_queued_message',
  {
    uiCapabilities: jsonb('ui_capabilities').$type<UiCapabilities>(),
    hostContext: jsonb('host_context').$type<AgentHostContext>(),
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
      // NULL for usage recorded outside any conversation (`AgentService.recordUsage`).
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
    /** Where `cost_usd` came from: `'provider'` (reported) or `'estimate'` (tokens × the price row); null on rows from before it existed (reported). */
    costSource: text('cost_source').$type<CostSource>(),
    /** The run the row belongs to. */
    runId: text('run_id'),
    /** What the spend was for: `agent:<name>` for an agent turn, the app's own otherwise; null → `agent`. */
    feature: text('feature'),
    provider: text('provider'),
    tenantRef: text('tenant_ref'),
    /** Units a row bills by when they are not tokens. */
    audioSeconds: doublePrecision('audio_seconds'),
    characters: bigint('characters', { mode: 'number' }),
    requests: integer('requests'),
    /** The caller's own JSON, never read by the library. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** `false` keeps the row out of the agent's quota windows (`recordUsage({ countsTowardsQuota: false })`). */
    countsTowardsQuota: boolean('counts_towards_quota').notNull().default(true),
    createdAt: ts('created_at').notNull(),
  },
  (table) => [
    index('agent_token_usage_actor_created_idx').on(table.actorRef, table.createdAt),
    index('agent_token_usage_created_idx').on(table.createdAt),
    index('agent_token_usage_thread_idx').on(table.threadId),
    index('agent_token_usage_feature_created_idx').on(table.feature, table.createdAt),
  ],
);

/**
 * Generative-UI telemetry (`AgentStore.recordGenuiCalls`): one row per UI tool call, keyed by the
 * tool call's id, so a replayed record replaces rather than duplicates. Metadata only — `payload`
 * (the call's arguments) is filled solely when the tool samples payloads. `created_at` is epoch-ms.
 */
export const agentGenuiCall = pgTable(
  'agent_genui_call',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThread.id, { onDelete: 'cascade' }),
    actorRef: text('actor_ref').notNull(),
    agentName: text('agent_name'),
    step: integer('step').notNull(),
    toolName: text('tool_name').notNull(),
    channel: text('channel').notNull(),
    mode: text('mode').$type<GenuiToolMarker['mode']>().notNull(),
    modelId: text('model_id').notNull(),
    attempt: integer('attempt').notNull(),
    outcome: text('outcome').$type<RecordGenuiCallInput['outcome']>().notNull(),
    validity: text('validity').$type<GenuiValidity>().notNull(),
    errorCategory: text('error_category').$type<GenuiErrorCategory>(),
    errorMessage: text('error_message'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: doublePrecision('cost_usd'),
    costSource: varchar('cost_source', { length: 16 }).$type<CostSource>(),
    firstFrameMs: bigint('first_frame_ms', { mode: 'number' }),
    completeFrameMs: bigint('complete_frame_ms', { mode: 'number' }),
    payloadBytes: integer('payload_bytes').notNull(),
    payload: text('payload'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('agent_genui_call_created_idx').on(table.createdAt),
    index('agent_genui_call_run_idx').on(table.runId),
  ],
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
    /** Turn start to the first `text` frame; null for a run that streamed none or did not complete. */
    ttftMs: integer('ttft_ms'),
    /** The run's known spend (the sum of its model calls with a known cost); null when none had one. */
    costUsd: doublePrecision('cost_usd'),
    /** The model the run's last model call resolved to. */
    modelId: text('model_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retries: integer('retries').notNull().default(0),
    startedAt: ts('started_at').notNull(),
    settledAt: ts('settled_at'),
    promptHash: text('prompt_hash'),
    parentRunId: text('parent_run_id'),
    /** Enqueue → body start (ms); null when not read. */
    queueMs: integer('queue_ms'),
    /** Where the completed run's time went: model and tool totals, counts, and the per-step list. */
    modelMs: integer('model_ms'),
    toolsMs: integer('tools_ms'),
    modelCalls: integer('model_calls'),
    toolCalls: integer('tool_calls'),
    timings: jsonb('timings').$type<RunStepTiming[]>(),
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

/**
 * Text channels' short-lived state (`@dudousxd/nestjs-agent-channels`), one row per key: the provider
 * message ids already answered, a question waiting for the person's answer, an outcome already
 * relayed. The primary key is the lock a claim takes; `expires_at` is epoch-ms, and past it the row
 * is free again and dead weight for `DrizzleChannelStore.purgeExpired`. Keys longer than 255
 * characters are stored by their SHA-256.
 */
export const agentChannelState = pgTable(
  'agent_channel_state',
  {
    key: text('key').primaryKey(),
    value: text('value'),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('agent_channel_state_expires_idx').on(table.expiresAt)],
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

/**
 * Personal Agent Protocol (Poppy) conversations (`DrizzlePoppyStore`): who it is with, its status,
 * the User's context and the identity its turns run as (JSON text), and the reader lease
 * (`reader_holder` until `reader_until`, epoch-ms) that lets one replica at a time write a reply.
 * `pruned_seq`: events at or below it were pruned.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export const agentPoppyConversation = pgTable('agent_poppy_conversation', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: text('user_id').notNull(),
  accountRef: text('account_ref'),
  agentName: text('agent_name').notNull(),
  threadId: text('thread_id'),
  parentId: text('parent_id'),
  openDirectId: text('open_direct_id'),
  status: text('status').notNull(),
  responder: text('responder').notNull(),
  context: text('context'),
  activeRunId: text('active_run_id'),
  turnSeq: bigint('turn_seq', { mode: 'number' }).notNull(),
  grantInfo: text('grant_info'),
  readerHolder: text('reader_holder'),
  readerUntil: bigint('reader_until', { mode: 'number' }),
  prunedSeq: bigint('pruned_seq', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

/**
 * A Poppy conversation's events, append-only, numbered per conversation. The primary key is the
 * position, so two appends racing for one cannot both win; `event_key` (unique per conversation)
 * is what keeps a re-read turn from writing its reply twice. `event` is the event as JSON text.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export const agentPoppyEvent = pgTable(
  'agent_poppy_event',
  {
    conversationId: text('conversation_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    event: text('event').notNull(),
    eventKey: text('event_key'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.seq] }),
    uniqueIndex('agent_poppy_event_key_idx').on(table.conversationId, table.eventKey),
    index('agent_poppy_event_id_idx').on(table.conversationId, table.id),
  ],
);

/**
 * Accepted Poppy messages, one row per (owner, message id) — the primary key is the idempotency lock
 * that makes two deliveries of one message one (§7.3); `response` is what the first got, as JSON.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export const agentPoppyMessage = pgTable(
  'agent_poppy_message',
  {
    owner: text('owner').notNull(),
    messageId: text('message_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    conversationId: text('conversation_id').notNull(),
    response: text('response').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.owner, table.messageId] })],
);

/**
 * This app's Poppy connections (`DrizzlePoppyConnectionStore`): one per (owner, Company issuer),
 * holding the client state SEALED by the caller — never a token in the clear.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export const agentPoppyConnection = pgTable(
  'agent_poppy_connection',
  {
    owner: text('owner').notNull(),
    issuer: text('issuer').notNull(),
    domain: text('domain').notNull(),
    organization: text('organization').notNull(),
    scope: text('scope').notNull(),
    status: text('status').notNull(),
    state: text('state').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.owner, table.issuer] })],
);

/**
 * Poppy sign-ins in flight, started by the `connect` tool and completed on the connect page. `actor`
 * is JSON text; `flow` the sealed per-method state.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export const agentPoppyConnect = pgTable('agent_poppy_connect', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  domain: text('domain').notNull(),
  issuer: text('issuer').notNull(),
  organization: text('organization').notNull(),
  scope: text('scope').notNull(),
  actor: text('actor'),
  threadId: text('thread_id'),
  runId: text('run_id'),
  toolCallId: text('tool_call_id'),
  flow: text('flow'),
  status: text('status').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

/** Every agent table, for `drizzle(pool, { schema: pgAgentSchema })` on Postgres. */
export const pgAgentSchema = {
  agentActionProposal,
  agentThread,
  agentMessage,
  agentQueuedMessage,
  agentToolCall,
  agentTokenUsage,
  agentGenuiCall,
  agentModelPricing,
  agentRun,
  agentMemory,
  ragIngestionLog,
  agentConfirmToken,
  agentChannelState,
  agentStreamFrame,
  agentPoppyConversation,
  agentPoppyEvent,
  agentPoppyMessage,
  agentPoppyConnection,
  agentPoppyConnect,
};
