import { sql } from 'drizzle-orm';
import type { AgentDrizzleDb } from './schema.js';

/**
 * Idempotent `CREATE TABLE IF NOT EXISTS` DDL for the six agent tables, mirroring
 * {@link import('./schema.js').agentSchema}. SQLite dialect (the db-test driver); kept here rather
 * than relying on drizzle-kit so the package can stand up its schema with no migration files. Safe
 * to run on boot against a shared database — it never drops or alters existing columns.
 */
const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS agent_thread (
    id TEXT PRIMARY KEY NOT NULL,
    actor_ref TEXT NOT NULL,
    tenant_ref TEXT,
    title TEXT NOT NULL,
    transient INTEGER NOT NULL DEFAULT 0,
    active_stream_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS agent_thread_actor_updated_idx
    ON agent_thread (actor_ref, updated_at)`,
  `CREATE TABLE IF NOT EXISTS agent_message (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_results TEXT,
    follow_ups TEXT,
    usage TEXT,
    agent_name TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS agent_message_thread_created_idx
    ON agent_message (thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS agent_tool_call (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL REFERENCES agent_message(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    tool_type TEXT NOT NULL,
    input TEXT,
    output TEXT,
    status TEXT NOT NULL,
    executed_by_ref TEXT,
    execution_ms INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    executed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS agent_token_usage (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
    actor_ref TEXT NOT NULL,
    message_id TEXT,
    model_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER,
    cache_read_tokens INTEGER,
    cost_usd REAL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS agent_token_usage_actor_created_idx
    ON agent_token_usage (actor_ref, created_at)`,
  `CREATE TABLE IF NOT EXISTS agent_model_pricing (
    id TEXT PRIMARY KEY NOT NULL,
    model_id TEXT NOT NULL,
    input_price_per_1m REAL NOT NULL,
    output_price_per_1m REAL NOT NULL,
    cache_write_price_per_1m REAL,
    cache_read_price_per_1m REAL,
    effective_from INTEGER NOT NULL,
    is_current INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
    actor_ref TEXT NOT NULL,
    agent_name TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    error_code TEXT,
    error_message TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    settled_at INTEGER,
    prompt_hash TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS agent_run_started_idx
    ON agent_run (started_at)`,
];

/** Runs the `CREATE TABLE IF NOT EXISTS` DDL above against the supplied Drizzle SQLite db. */
export async function ensureAgentSchema(db: AgentDrizzleDb): Promise<void> {
  for (const statement of statements) {
    await db.run(sql.raw(statement));
  }
}
