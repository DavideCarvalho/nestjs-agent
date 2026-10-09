// Integration: ensureAgentSchema healing real databases. The first block is SQLite's own table
// REBUILD path (hand-written old shapes); the second runs on SQLite, Postgres and MySQL alike. Runs
// only under `pnpm test:db`.
import { EntitySchema, MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import {
  agentEntitiesFor,
  columnsOf,
  describeEachDialect,
  dialectOf,
  indexesOf,
  openFreshOrm,
  openOrmAt,
  rawSql,
} from './testing/real-db';

/** An `agent_thread` from an older revision of the lib: no tenant, stream, agent or soft delete. */
const THREAD_BEFORE_COLUMNS_WERE_ADDED = `create table agent_thread (
  id text not null primary key,
  actor_ref text not null,
  title text not null,
  transient integer not null default 0,
  created_at datetime not null,
  updated_at datetime not null
)`;

/** An `agent_run` from before a child run recorded which run delegated it. */
const RUN_BEFORE_PARENT_WAS_RECORDED = `create table agent_run (
  id text not null primary key,
  thread_id text not null,
  actor_ref text not null,
  agent_name text null,
  status text not null,
  duration_ms integer null,
  error_code text null,
  error_message text null,
  retries integer not null default 0,
  started_at datetime not null,
  settled_at datetime null,
  prompt_hash text null,
  constraint agent_run_thread_id_foreign foreign key (thread_id) references agent_thread (id) on delete cascade
)`;

/** `agent_message` as it stood before reasoning and pushed UI were persisted. */
const MESSAGE_BEFORE_REASONING_WAS_RECORDED = `create table agent_message (
  id text not null primary key,
  thread_id text not null,
  role text not null,
  content text not null,
  tool_calls json null,
  tool_results json null,
  attachments json null,
  follow_ups json null,
  usage json null,
  agent_name text null,
  run_id text null,
  created_at datetime not null,
  constraint agent_message_thread_id_foreign foreign key (thread_id) references agent_thread (id) on delete cascade
)`;

/** `agent_tool_call` as it stood before approvals recorded who, until when and how. */
const TOOL_CALL_BEFORE_APPROVALS_WERE_RECORDED = `create table agent_tool_call (
  id text not null primary key,
  message_id text not null,
  tool_name text not null,
  tool_type text not null,
  input json null,
  output json null,
  status text not null,
  executed_by_ref text null,
  execution_ms integer null,
  error text null,
  created_at datetime not null,
  executed_at datetime null,
  run_id text null,
  constraint agent_tool_call_message_id_foreign foreign key (message_id) references agent_message (id) on delete cascade
)`;

/** A host table the store does not own, missing a column its entity declares. */
class HostNote {
  id!: string;
  body!: string;
  pinned?: boolean | null;
}

const hostNoteSchema = new EntitySchema<HostNote>({
  class: HostNote,
  tableName: 'host_note',
  properties: {
    id: { type: 'string', primary: true },
    body: { type: 'string' },
    pinned: { type: 'boolean', nullable: true },
  },
});

async function orm(extra: EntitySchema[] = []): Promise<MikroORM> {
  return MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: [...agentEntities(), ...extra],
    allowGlobalContext: true,
  });
}

async function foreignKeysEnforced(instance: MikroORM): Promise<boolean> {
  const rows: { foreign_keys: number }[] = await instance.em
    .getConnection()
    .execute('pragma foreign_keys');
  return Boolean(rows[0]?.foreign_keys);
}

async function storedFingerprint(instance: MikroORM): Promise<string | undefined> {
  const rows: { fingerprint: string }[] = await instance.em
    .getConnection()
    .execute("select fingerprint from agent_schema_meta where id = 'agent'");
  return rows[0]?.fingerprint;
}

/**
 * SQLite has no `add column` for most changes: MikroORM emits a table REBUILD (create a
 * `__temp_alter` twin, copy the rows into it, drop the original, rename). The heal has to apply that
 * whole sequence — and when it cannot, it has to say so instead of stamping the fingerprint that
 * stops every later boot from trying again.
 */
describe('ensureAgentSchema — healing a table that is missing columns', () => {
  it('adds the columns, keeps the rows, and only then records the fingerprint', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      await connection.execute(
        "insert into agent_thread values ('t1', 'actor-1', 'Old chat', 0, '2026-01-01 00:00:00', '2026-01-02 00:00:00')",
      );

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_thread')).toEqual([
        'id',
        'actor_ref',
        'tenant_ref',
        'title',
        'transient',
        'active_stream_id',
        'default_agent',
        'model',
        'persona',
        'queue_pause',
        'created_at',
        'updated_at',
        'deleted_at',
      ]);
      const store = new MikroOrmAgentStore(instance.em);
      expect((await store.getThread('t1'))?.title).toBe('Old chat');
      await store.updateThread('t1', { defaultAgent: 'researcher', persona: 'sql-focused' });
      expect(await store.defaultAgentForThread('t1')).toBe('researcher');
      expect(await store.personaForThread('t1')).toBe('sql-focused');
      expect(await storedFingerprint(instance)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await instance.close(true);
    }
  });

  it('keeps the child rows a dropped parent would have cascaded away, and restores enforcement', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      // Current children, an `agent_thread` from before the columns were added, and rows in both.
      for (const sql of await agentSchemaSql(instance, { ifNotExists: false })) {
        await connection.execute(sql);
      }
      await connection.execute('drop table agent_thread');
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      await connection.execute(
        "insert into agent_thread values ('t1', 'actor-1', 'Old chat', 0, '2026-01-01 00:00:00', '2026-01-02 00:00:00')",
      );
      const store = new MikroOrmAgentStore(instance.em);
      await store.appendMessage({ threadId: 't1', role: 'user', content: 'still here' });
      expect(await foreignKeysEnforced(instance)).toBe(true);

      await ensureAgentSchema(instance);

      expect((await store.getThread('t1'))?.messages.map((message) => message.content)).toEqual([
        'still here',
      ]);
      expect(await foreignKeysEnforced(instance)).toBe(true);
    } finally {
      await instance.close(true);
    }
  });

  it('adds a column to a table that already has rows and children', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      for (const sql of await agentSchemaSql(instance, { ifNotExists: false })) {
        await connection.execute(sql);
      }
      // `agent_run` as it stood before the delegation edge was recorded.
      await connection.execute('drop table agent_run');
      await connection.execute(RUN_BEFORE_PARENT_WAS_RECORDED);
      await connection.execute(
        "insert into agent_thread (id, actor_ref, title, transient, created_at, updated_at) values ('t1', 'a1', 'Chat', 0, '2026-01-01', '2026-01-01')",
      );
      await connection.execute(
        "insert into agent_run (id, thread_id, actor_ref, status, retries, started_at) values ('r1', 't1', 'a1', 'completed', 0, '2026-01-01')",
      );

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_run')).toContain('parent_run_id');
      const rows: { id: string }[] = await connection.execute('select id from agent_run');
      expect(rows.map((row) => row.id)).toEqual(['r1']);
    } finally {
      await instance.close(true);
    }
  });

  it('adds the reasoning and ui columns to an existing agent_message and keeps its rows', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      for (const sql of await agentSchemaSql(instance, { ifNotExists: false })) {
        await connection.execute(sql);
      }
      await connection.execute('drop table agent_message');
      await connection.execute(MESSAGE_BEFORE_REASONING_WAS_RECORDED);
      await connection.execute(
        "insert into agent_thread (id, actor_ref, title, transient, created_at, updated_at) values ('t1', 'a1', 'Chat', 0, '2026-01-01', '2026-01-01')",
      );
      await connection.execute(
        "insert into agent_message (id, thread_id, role, content, created_at) values ('m1', 't1', 'user', 'old row', '2026-01-01')",
      );

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_message')).toEqual(
        expect.arrayContaining(['reasoning', 'reasoning_ms', 'ui', 'feedback']),
      );
      const store = new MikroOrmAgentStore(instance.em);
      await store.appendMessage({
        threadId: 't1',
        role: 'assistant',
        content: 'new row',
        reasoning: 'thinking',
        reasoningMs: 900,
        ui: [{ id: 'u', component: 'stat', props: {} }],
      });
      const messages = (await store.getThread('t1'))?.messages ?? [];
      expect(messages.map((message) => message.content).sort()).toEqual(['new row', 'old row']);
      expect(messages.find((message) => message.content === 'new row')).toMatchObject({
        reasoning: 'thinking',
        reasoningMs: 900,
        ui: [{ id: 'u', component: 'stat', props: {} }],
      });
    } finally {
      await instance.close(true);
    }
  });

  it('adds the approval columns to an existing agent_tool_call and round-trips them', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      for (const sql of await agentSchemaSql(instance, { ifNotExists: false })) {
        await connection.execute(sql);
      }
      await connection.execute('drop table agent_tool_call');
      await connection.execute(TOOL_CALL_BEFORE_APPROVALS_WERE_RECORDED);

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_tool_call')).toEqual(
        expect.arrayContaining(['approver', 'expires_at', 'remember', 'decided_via']),
      );
      const store = new MikroOrmAgentStore(instance.em);
      const thread = await store.createThread({ actor: { id: 'a1' } });
      const other = await store.createThread({ actor: { id: 'a1' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'purging',
        toolCalls: [{ id: 'c1', name: 'purge', input: {} }],
      });
      await store.recordToolCall({
        toolCallId: 'c1',
        messageId: message.id,
        toolName: 'purge',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        approver: 'ops',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      expect(await store.toolCallInput('c1')).toEqual({});
      expect(await store.toolCallInput('missing')).toBeNull();
      expect(await store.toolCallApproval('c1')).toEqual({
        status: 'pending_approval',
        approver: 'ops',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      expect(await store.rememberedApprovals(thread.id)).toEqual([]);

      await store.updateToolCall({
        toolCallId: 'c1',
        status: 'executed',
        executedByRef: 'op-1',
        remember: true,
        decidedVia: 'slack',
      });
      expect((await store.getThread(thread.id))?.messages[0]?.approvals).toEqual([
        {
          toolCallId: 'c1',
          approver: 'ops',
          status: 'approved',
          expiresAt: '2030-01-01T00:00:00.000Z',
          remember: true,
          decidedBy: 'op-1',
          decidedVia: 'slack',
        },
      ]);
      expect(await store.rememberedApprovals(thread.id)).toEqual(['purge']);
      expect(await store.rememberedApprovals(other.id)).toEqual([]);
    } finally {
      await instance.close(true);
    }
  });

  it('leaves a host table the store does not own untouched', async () => {
    const instance = await orm([hostNoteSchema]);
    try {
      const connection = instance.em.getConnection();
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      await connection.execute(
        'create table host_note (id text not null primary key, body text not null)',
      );
      await connection.execute("insert into host_note values ('n1', 'host row')");

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'host_note')).toEqual(['id', 'body']);
      const rows: { id: string }[] = await connection.execute('select id from host_note');
      expect(rows.map((row) => row.id)).toEqual(['n1']);
    } finally {
      await instance.close(true);
    }
  });

  it('throws and records nothing when the statements the diff asked for do not land', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      // A database that accepts the whole rebuild and does nothing with it — the shape the bug had,
      // and the shape a filtered-out statement, a silent driver and a lying proxy all share.
      const execute = connection.execute.bind(connection);
      connection.execute = (async (query: string, ...rest: unknown[]) =>
        typeof query === 'string' && /__temp_alter|^drop\s+table/i.test(query)
          ? []
          : execute(query, ...(rest as []))) as typeof connection.execute;

      await expect(ensureAgentSchema(instance)).rejects.toThrow(/agent schema heal did not apply/i);

      expect(await columnsOf(instance, 'agent_thread')).not.toContain('default_agent');
      expect(await storedFingerprint(instance)).toBeUndefined();
      // A boot that failed must not leave the connection writing without its foreign keys.
      expect(await foreignKeysEnforced(instance)).toBe(true);
    } finally {
      await instance.close(true);
    }
  });
});

/**
 * Columns each table gained after its first release. Dropping them from a current schema is what an
 * older install of the lib looks like on any dialect — in the types that dialect's MikroORM really
 * emitted, which a hand-written "old" DDL would only approximate.
 */
const ADDED_LATER: Record<string, string[]> = {
  agent_thread: [
    'tenant_ref',
    'active_stream_id',
    'default_agent',
    'model',
    'persona',
    'queue_pause',
    'deleted_at',
  ],
  agent_run: ['parent_run_id'],
  agent_message: ['reasoning', 'reasoning_ms', 'ui', 'feedback', 'attachments', 'seq', 'persona'],
  agent_tool_call: ['approver', 'expires_at', 'remember', 'decided_via'],
  agent_token_usage: ['cost_source'],
};

/** The update DDL the differ still wants for agent tables — empty once the heal has landed. */
async function pendingAgentDdl(instance: MikroORM): Promise<string[]> {
  const generator = instance.em
    .getPlatform()
    .getSchemaGenerator(instance.em.getDriver(), instance.em);
  const sql = await generator.getUpdateSchemaSQL({ safe: true, wrap: false });
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /\bagent_|\brag_ingestion_log\b/.test(statement));
}

describeEachDialect('ensureAgentSchema on a real database', (dialect) => {
  const opened: MikroORM[] = [];
  async function fresh(extra: EntitySchema[] = []): Promise<MikroORM> {
    const instance = await openFreshOrm(
      dialect,
      extra.length > 0 ? { entities: [...agentEntitiesFor(dialect), ...extra] } : {},
    );
    opened.push(instance);
    return instance;
  }

  afterEach(async () => {
    for (const instance of opened.splice(0)) await instance.close(true);
  });

  it('creates every table on an empty database, and leaves the differ nothing to do', async () => {
    const instance = await fresh();

    await ensureAgentSchema(instance);

    expect(await pendingAgentDdl(instance)).toEqual([]);
    expect(await storedFingerprint(instance)).toMatch(/^[a-f0-9]{64}$/);
    const store = new MikroOrmAgentStore(instance.em);
    const thread = await store.createThread({ actor: { id: 'a' }, title: 'boot' });
    expect((await store.getThread(thread.id))?.title).toBe('boot');
  });

  it('adds independent proposals to an older install and preserves data on repeated provision', async () => {
    const instance = await fresh();
    for (const statement of await agentSchemaSql(instance, { ifNotExists: false })) {
      if (!statement.includes('agent_action_proposal')) await rawSql(instance, statement);
    }
    const store = new MikroOrmAgentStore(instance.em, { clock: () => 1000 });
    const thread = await store.createThread({ actor: { id: 'owner' }, title: 'Existing chat' });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'Keep this message' });
    await ensureAgentSchema(instance);
    const input = {
      id: 'old-install-proposal',
      tenantRef: null,
      actorRef: 'owner',
      threadId: thread.id,
      originRunId: 'run',
      originMessageId: 'message',
      originToolCallId: 'call',
      toolName: 'refund',
      input: { amount: 5 },
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'requester',
      expiresAt: 2000,
      idempotencyKey: 'stable-key',
    };
    expect((await store.createActionProposal(input)).status).toBe('created');
    await ensureAgentSchema(instance);
    expect(await store.getActionProposal(input, input.id)).toMatchObject({
      decision: 'pending',
      execution: null,
      idempotencyKey: 'stable-key',
    });
    expect((await store.getThread(thread.id))?.messages.map((message) => message.content)).toEqual([
      'Keep this message',
    ]);
    expect((await indexesOf(instance, 'agent_action_proposal')).map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'agent_proposal_scope_created_idx',
        'agent_proposal_scope_decision_idx',
        'agent_proposal_work_lease_idx',
      ]),
    );
    expect(await pendingAgentDdl(instance)).toEqual([]);
  });

  it('adds every later column back to tables that hold rows, and keeps the rows', async () => {
    const instance = await fresh();
    for (const statement of await agentSchemaSql(instance, { ifNotExists: false })) {
      await rawSql(instance, statement);
    }
    for (const [table, columns] of Object.entries(ADDED_LATER)) {
      for (const column of columns) {
        await rawSql(instance, `alter table ${table} drop column ${column}`);
      }
    }
    const transient = dialect === 'postgres' ? 'false' : '0';
    await rawSql(
      instance,
      `insert into agent_thread (id, actor_ref, title, transient, created_at, updated_at) values ('t1', 'a1', 'Old chat', ${transient}, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    );
    await rawSql(
      instance,
      "insert into agent_message (id, thread_id, role, content, created_at) values ('m1', 't1', 'user', 'old row', '2026-01-01 00:00:00')",
    );
    await rawSql(
      instance,
      "insert into agent_run (id, thread_id, actor_ref, status, retries, started_at) values ('r1', 't1', 'a1', 'completed', 0, '2026-01-01 00:00:00')",
    );

    await ensureAgentSchema(instance);

    for (const [table, columns] of Object.entries(ADDED_LATER)) {
      expect(await columnsOf(instance, table)).toEqual(expect.arrayContaining(columns));
    }
    expect(await pendingAgentDdl(instance)).toEqual([]);
    const store = new MikroOrmAgentStore(instance.em);
    expect((await store.getThread('t1'))?.messages.map((message) => message.content)).toEqual([
      'old row',
    ]);
    await store.updateThread('t1', { defaultAgent: 'researcher' });
    expect(await store.defaultAgentForThread('t1')).toBe('researcher');
    const runs: { id: string }[] = await rawSql(instance, 'select id from agent_run');
    expect(runs.map((row) => row.id)).toEqual(['r1']);
  });

  it('leaves a host table the store does not own untouched', async () => {
    const instance = await fresh([hostNoteSchema]);
    await rawSql(
      instance,
      'create table host_note (id varchar(64) not null primary key, body varchar(255) not null)',
    );
    await rawSql(instance, "insert into host_note values ('n1', 'host row')");

    await ensureAgentSchema(instance);

    expect(await columnsOf(instance, 'host_note')).toEqual(['id', 'body']);
  });

  it('lets several replicas boot at once against an empty database', async () => {
    if (dialect === 'sqlite') return; // one in-memory connection: there is no second replica
    const first = await fresh();
    const url = first.config.get('clientUrl') as string;
    const others = await Promise.all(
      [1, 2, 3].map(async () => {
        const replica = await openOrmAt(dialect, url);
        opened.push(replica);
        return replica;
      }),
    );

    await Promise.all([first, ...others].map((instance) => ensureAgentSchema(instance)));

    expect(await pendingAgentDdl(first)).toEqual([]);
  });

  it('indexes the columns every message-scoped and thread-scoped read filters on', async () => {
    const instance = await fresh();
    await ensureAgentSchema(instance);
    const leading = async (table: string) =>
      (await indexesOf(instance, table)).map((index) => index.columns[0]);
    // `truncateFrom`'s delete and the turn reader's IN (…) — and the cascade from agent_message.
    expect(await leading('agent_tool_call')).toContain('message_id');
    expect(await leading('agent_message')).toContain('thread_id');
    expect(dialectOf(instance)).toBe(dialect);
  });
  it('widens an install from before sub-second timestamps and unbounded text, and only on MySQL', async () => {
    const instance = await fresh();
    // The DDL this lib rendered before: whole-second `datetime` and 64 KB `text` on MySQL, and on
    // Postgres the very same schema it renders now.
    for (const statement of await agentSchemaSql(instance, { ifNotExists: false })) {
      await rawSql(
        instance,
        statement
          .replaceAll('datetime(6)', 'datetime')
          .replaceAll('timestamptz(6)', 'timestamptz')
          .replaceAll('longtext', 'text'),
      );
    }
    const before = await pendingAgentDdl(instance);
    if (dialect === 'mysql') {
      expect(before.some((sql) => /modify `created_at` datetime\(6\)/.test(sql))).toBe(true);
      expect(before.some((sql) => /modify `content` longtext/.test(sql))).toBe(true);
    } else {
      // Nothing to alter: an upgrade must not rewrite a Postgres or SQLite table at boot.
      expect(before).toEqual([]);
    }

    await ensureAgentSchema(instance);

    expect(await pendingAgentDdl(instance)).toEqual([]);
    const store = new MikroOrmAgentStore(instance.em);
    const thread = await store.createThread({ actor: { id: 'a' } });
    const big = 'y'.repeat(100_000);
    await store.appendMessage({ threadId: thread.id, role: 'user', content: big });
    const [message] = (await store.getThread(thread.id))?.messages ?? [];
    expect(message?.content.length).toBe(big.length);
  });
});
