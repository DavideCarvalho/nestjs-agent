// Integration: DrizzleAgentStore + ensureAgentSchema on SQLite, Postgres and MySQL (each a fresh
// database; see ./testing/real-db). Runs only under `pnpm test:db`.
import type {
  RecordRunEndInput,
  RecordRunStartInput,
  StoredMessage,
  ThreadSummary,
  UpdateThreadInput,
} from '@dudousxd/nestjs-agent-core';
import { EVERY_MESSAGE_FIELD } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSqliteDb } from './dialect.js';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import {
  type AgentRunStatus,
  agentMessage,
  agentRun,
  agentSchema,
  agentToolCall,
} from './schema.js';
import {
  type AgentDbHandle,
  columnsOf,
  describeEachDialect,
  indexesOf,
  openAgentDb,
} from './testing/real-db.js';

describeEachDialect('DrizzleAgentStore', (dialect) => {
  let handle: AgentDbHandle;
  let db: AgentSqliteDb;
  let store: DrizzleAgentStore;

  beforeAll(async () => {
    handle = await openAgentDb(dialect);
    db = handle.q;
    store = new DrizzleAgentStore(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  // One database per dialect, emptied before every case.
  beforeEach(async () => {
    await handle.reset();
  });

  describe('DrizzleAgentStore', () => {
    it('roundtrips resolved confirmation and preserves approved metadata after domain refusal', async () => {
      const confirmation = { title: 'Remove 3 sessions?', verb: 'Remove', detail: 'For account A' };
      const thread = await store.createThread({ actor: { id: 'preflight-actor' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'removing',
        toolCalls: [{ id: 'preflight-call', name: 'remove', input: {} }],
      });
      await store.recordToolCall({
        toolCallId: 'preflight-call',
        messageId: message.id,
        toolName: 'remove',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        approver: 'requester',
        confirmation,
      });
      expect((await store.getThread(thread.id))?.messages[0]?.approvals?.[0]).toMatchObject({
        status: 'pending',
        confirmation,
      });
      await store.updateToolCall({
        toolCallId: 'preflight-call',
        status: 'failed',
        error: 'account became locked',
        executedByRef: 'preflight-actor',
        decidedVia: 'web',
      });
      expect((await store.getThread(thread.id))?.messages[0]?.approvals?.[0]).toMatchObject({
        status: 'approved',
        confirmation,
        decidedBy: 'preflight-actor',
      });
    });

    it('creates a thread under the id the caller names, and refuses one already taken', async () => {
      const actor = { id: 'named-actor' };
      const named = await store.createThread({ actor, id: 'thread-from-client' });
      expect(named.id).toBe('thread-from-client');
      expect(await store.ownerOfThread('thread-from-client')).toBe('named-actor');
      await expect(store.createThread({ actor, id: 'thread-from-client' })).rejects.toThrow();
    });

    it('persists threads, messages, tool calls, usage and honours fork/truncate/soft-delete', async () => {
      const today = new Date().toISOString().slice(0, 10);

      // createThread
      const thread = await store.createThread({
        actor: { id: 'actor-1' },
        title: 'My chat',
      });
      expect(thread.id).toBeTruthy();
      expect(thread.title).toBe('My chat');
      expect(thread.transient).toBe(false);

      // appendMessage (user)
      const userMessage = await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'Hello',
      });
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('Hello');

      // appendMessage (assistant with tool calls + usage)
      const assistantMessage = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'Looking that up',
        toolCalls: [{ id: 'tc-1', name: 'lookup', input: { q: 'weather' } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        agentName: 'researcher',
      });
      expect(assistantMessage.toolCalls).toEqual([
        { id: 'tc-1', name: 'lookup', input: { q: 'weather' } },
      ]);
      expect(assistantMessage.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(assistantMessage.agentName).toBe('researcher');

      // recordToolCall (pending) → updateToolCall (executed)
      await store.recordToolCall({
        toolCallId: 'tc-1',
        messageId: assistantMessage.id,
        toolName: 'lookup',
        toolType: 'read',
        input: { q: 'weather' },
        status: 'pending_approval',
        runId: 'run-tc-1',
      });
      await store.updateToolCall({
        toolCallId: 'tc-1',
        status: 'executed',
        output: { result: 'sunny' },
        executionMs: 12,
        executedByRef: 'worker-1',
      });

      const [toolCall] = await db
        .select()
        .from(handle.t.agentToolCall)
        .where(eq(handle.t.agentToolCall.id, 'tc-1'));
      expect(toolCall?.status).toBe('executed');
      expect(toolCall?.output).toEqual({ result: 'sunny' });
      // runId round-trips from recordToolCall through to the persisted row
      expect(toolCall?.runId).toBe('run-tc-1');

      // recordToolCall without a runId persists NULL, not undefined — a pre-rollout-shaped call
      await store.recordToolCall({
        toolCallId: 'tc-no-run',
        messageId: assistantMessage.id,
        toolName: 'lookup',
        toolType: 'read',
        input: {},
        status: 'auto_executed',
      });
      const [noRunToolCall] = await db
        .select()
        .from(handle.t.agentToolCall)
        .where(eq(handle.t.agentToolCall.id, 'tc-no-run'));
      expect(noRunToolCall?.runId).toBeNull();

      // ownerOfThread / ownerOfToolCall resolve the owning actorRef for the authz checks
      expect(await store.ownerOfThread(thread.id)).toBe('actor-1');
      expect(await store.ownerOfToolCall('tc-1')).toBe('actor-1');
      expect(await store.ownerOfThread('missing')).toBeNull();
      expect(await store.ownerOfToolCall('missing')).toBeNull();
      expect(toolCall?.executionMs).toBe(12);
      expect(toolCall?.executedByRef).toBe('worker-1');
      expect(toolCall?.executedAt).toBeInstanceOf(Date);

      // getThread → both messages in order, with tool-call data preserved
      const detail = await store.getThread(thread.id);
      expect(detail).not.toBeNull();
      const messages = detail?.messages as StoredMessage[];
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe('Hello');
      expect(messages[1]?.content).toBe('Looking that up');
      expect(messages[1]?.toolCalls?.[0]?.id).toBe('tc-1');
      expect(messages[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(messages[1]?.agentName).toBe('researcher');
      expect(detail?.lastMessagePreview).toBe('Looking that up');

      // setTitle + setActiveStream are reflected in getThread
      await store.setTitle(thread.id, 'Renamed');
      await store.setActiveStream(thread.id, 'run-9');
      const afterStream = await store.getThread(thread.id);
      expect(afterStream?.title).toBe('Renamed');
      expect(afterStream?.activeRunId).toBe('run-9');
      await store.setActiveStream(thread.id, null);
      expect((await store.getThread(thread.id))?.activeRunId).toBeUndefined();

      // recordUsage twice → quotaToday sums them
      await store.recordUsage({
        threadId: thread.id,
        actorRef: 'actor-1',
        modelId: 'model-x',
        purpose: 'chat',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      await store.recordUsage({
        threadId: thread.id,
        actorRef: 'actor-1',
        modelId: 'model-x',
        purpose: 'chat',
        usage: { inputTokens: 20, outputTokens: 7 },
      });
      const quota = await store.quotaToday('actor-1', today);
      expect(quota.usedTokens).toBe(42);
      // the same ledger over a range: a month that holds today counts it, one that ends before does not
      expect(
        (await store.usageBetween('actor-1', `${today.slice(0, 8)}01`, today)).usedTokens,
      ).toBe(42);
      expect((await store.usageBetween('actor-1', '2000-01-01', '2000-01-31')).usedTokens).toBe(0);
      const otherQuota = await store.quotaToday('actor-2', today);
      expect(otherQuota.usedTokens).toBe(0);

      // forkThread copies the prefix up to and including the user message
      const fork = await store.forkThread(thread.id, userMessage.id);
      expect(fork.id).not.toBe(thread.id);
      const forkDetail = await store.getThread(fork.id);
      expect(forkDetail?.messages).toHaveLength(1);
      expect(forkDetail?.messages[0]?.content).toBe('Hello');

      // truncateFrom drops the assistant message and onward
      await store.truncateFrom(thread.id, assistantMessage.id);
      const truncated = await store.getThread(thread.id);
      expect(truncated?.messages).toHaveLength(1);
      expect(truncated?.messages[0]?.content).toBe('Hello');
      // tool call attached to the dropped message is gone
      const remaining = await db
        .select()
        .from(handle.t.agentToolCall)
        .where(eq(handle.t.agentToolCall.id, 'tc-1'));
      expect(remaining).toHaveLength(0);

      // listThreads sees both threads before soft delete
      const before: ThreadSummary[] = await store.listThreads('actor-1');
      expect(before.map((t) => t.id).sort()).toEqual([thread.id, fork.id].sort());

      // softDeleteThread → getThread null + excluded from listThreads
      await store.softDeleteThread(thread.id);
      expect(await store.getThread(thread.id)).toBeNull();
      const after = await store.listThreads('actor-1');
      expect(after.map((t) => t.id)).toEqual([fork.id]);
    });

    it('records a run start/end and bumps retries atomically', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-run' } });

      await store.recordRunStart({
        runId: 'run-1',
        threadId: thread.id,
        actorRef: 'actor-run',
        agentName: 'researcher',
        promptHash: 'abc123def456',
      });
      const [started] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-1'));
      expect(started?.status).toBe('running');
      expect(started?.retries).toBe(0);
      expect(started?.agentName).toBe('researcher');
      expect(started?.settledAt).toBeNull();
      expect(started?.promptHash).toBe('abc123def456');

      // bumpRunRetries increments without a read-modify-write race (`retries + 1` in the SQL itself)
      await store.bumpRunRetries('run-1');
      await store.bumpRunRetries('run-1');
      const [bumped] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-1'));
      expect(bumped?.retries).toBe(2);

      await store.recordRunEnd({
        runId: 'run-1',
        status: 'completed',
        durationMs: 1_234,
      });
      const [settled] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-1'));
      expect(settled?.status).toBe('completed');
      expect(settled?.durationMs).toBe(1_234);
      expect(settled?.settledAt).toBeInstanceOf(Date);
      expect(settled?.errorCode).toBeNull();

      // a run with no agentName defaults to null, and a failed run carries the error fields
      await store.recordRunStart({ runId: 'run-2', threadId: thread.id, actorRef: 'actor-run' });
      await store.recordRunEnd({
        runId: 'run-2',
        status: 'failed',
        errorCode: 'timeout',
        errorMessage: 'upstream timed out',
      });
      const [failed] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-2'));
      expect(failed?.agentName).toBeNull();
      expect(failed?.status).toBe('failed');
      expect(failed?.errorCode).toBe('timeout');
      expect(failed?.errorMessage).toBe('upstream timed out');
      // a run started with no promptHash defaults to null
      expect(failed?.promptHash).toBeNull();

      // recordRunEnd/bumpRunRetries on an unknown run are silent no-ops
      await expect(
        store.recordRunEnd({ runId: 'missing', status: 'completed' }),
      ).resolves.toBeUndefined();
      await expect(store.bumpRunRetries('missing')).resolves.toBeUndefined();
    });

    it('resolves the owning actorRef of a thread streaming a run via ownerOfActiveStream', async () => {
      const thread = await store.createThread({
        actor: { id: 'actor-1' },
        title: 'My chat',
      });
      await store.setActiveStream(thread.id, 'run-xyz');
      expect(await store.ownerOfActiveStream('run-xyz')).toBe('actor-1');
      expect(await store.ownerOfActiveStream('missing')).toBeNull();
    });

    it('upserts model prices, superseding the prior current row', async () => {
      const pricingStore = new DrizzlePricingStore(db);

      await pricingStore.upsertModelPrice({
        modelId: 'm',
        inputPricePer1m: 3,
        outputPricePer1m: 15,
      });
      const firstPrices = await pricingStore.listCurrentPrices();
      const firstPrice = firstPrices.filter((price) => price.modelId === 'm');
      expect(firstPrice).toHaveLength(1);
      expect(firstPrice[0]?.inputPricePer1m).toBe(3);

      await pricingStore.upsertModelPrice({
        modelId: 'm',
        inputPricePer1m: 4,
        outputPricePer1m: 16,
      });
      const secondPrices = await pricingStore.listCurrentPrices();
      const secondPrice = secondPrices.filter((price) => price.modelId === 'm');
      expect(secondPrice).toHaveLength(1);
      expect(secondPrice[0]?.inputPricePer1m).toBe(4);
    });
  });

  describe('DrizzleAgentStore — a turn a client reads back', () => {
    it('replaces the components on a message with what the step pushed', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-1' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'charting',
        ui: [{ id: 'm1', component: 'Banner', props: { text: 'hi' } }],
      });
      const ui = [
        { id: 'm1', component: 'Banner', props: { text: 'hi' } },
        {
          id: 'c1:ui:0',
          component: 'Chart',
          props: { points: [1, 2] },
          version: 2,
          toolCallId: 'c1',
        },
      ];
      await store.setMessageUi(message.id, ui);
      await store.setMessageUi(message.id, ui);
      const stored = (await store.getThread(thread.id))?.messages.find(
        (candidate) => candidate.id === message.id,
      );
      expect(stored?.ui).toEqual(ui);
    });

    it('pairs every tool call on a message with the result the turn settled it with', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-1' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'looking',
        toolCalls: [
          { id: 'c1', name: 'lookup', input: {}, kind: 'read' },
          { id: 'c2', name: 'retrieve', input: { query: 'refunds' }, kind: 'read' },
        ],
        toolResults: [{ id: 'c2', name: 'retrieve', output: { passages: [] } }],
      });

      await store.setMessageToolResults(message.id, [
        { id: 'c1', name: 'lookup', output: { rows: 1 } },
        { id: 'c2', name: 'retrieve', output: { passages: [] } },
      ]);

      const [stored] = (await store.getThread(thread.id))?.messages ?? [];
      expect(stored?.toolResults).toEqual([
        { id: 'c1', name: 'lookup', output: { rows: 1 } },
        { id: 'c2', name: 'retrieve', output: { passages: [] } },
      ]);
    });
  });

  describe('DrizzleAgentStore — feedback on a message', () => {
    it('sets, replaces and clears a rating, resolves the message thread, and leaves forks unrated', async () => {
      const thread = await store.createThread({ actor: { id: 'rater' } });
      const answer = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'answer',
      });
      expect(await store.threadOfMessage(answer.id)).toBe(thread.id);
      expect(await store.threadOfMessage('missing')).toBeNull();

      await store.setMessageFeedback(answer.id, {
        value: 'down',
        comment: 'wrong total',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      expect((await store.getThread(thread.id))?.messages[0]?.feedback).toEqual({
        value: 'down',
        comment: 'wrong total',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });

      await store.setMessageFeedback(answer.id, {
        value: 'up',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
      expect((await store.getThread(thread.id))?.messages[0]?.feedback).toEqual({
        value: 'up',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });

      const fork = await store.forkThread(thread.id, answer.id);
      expect((await store.getThread(fork.id))?.messages[0]?.feedback).toBeUndefined();

      await store.setMessageFeedback(answer.id, null);
      expect((await store.getThread(thread.id))?.messages[0]).not.toHaveProperty('feedback');
    });
  });

  describe('DrizzleAgentStore — a thread patch a client reads back', () => {
    /**
     * Typed `Required<UpdateThreadInput>` so a new field on the patch fails to COMPILE here until this
     * adapter round-trips it. `defaultAgent` had no column at all on this adapter and no test noticed:
     * the write went nowhere and the value could never be read back.
     */
    const EVERY_PATCH_FIELD: Required<UpdateThreadInput> = {
      title: 'Renamed',
      defaultAgent: 'researcher',
      model: 'gpt-fast',
      persona: 'sql-focused',
    };

    it('returns every patched field from getThread', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-patch' } });

      await store.updateThread(thread.id, EVERY_PATCH_FIELD);

      expect(await store.getThread(thread.id)).toMatchObject(EVERY_PATCH_FIELD);
    });

    it('patches each field independently and clears defaultAgent on an explicit null', async () => {
      const thread = await store.createThread({
        actor: { id: 'actor-patch-2' },
        title: 'Original',
      });
      // never set — the column is there and holds null, which is NOT the same as the store not
      // knowing the field (that reads as undefined, and the service normalizes it the same way)
      expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

      await store.updateThread(thread.id, { title: 'Renamed' });
      expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

      await store.updateThread(thread.id, { defaultAgent: 'researcher' });
      const patched = await store.getThread(thread.id);
      expect(patched?.title).toBe('Renamed');
      expect(patched?.defaultAgent).toBe('researcher');

      await store.updateThread(thread.id, { defaultAgent: null });
      expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

      await expect(store.updateThread('missing', { title: 'x' })).resolves.toBeUndefined();
    });

    it('pins, reads, clears and forks the thread model', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-model' } });
      expect(await store.modelForThread(thread.id)).toBeNull();
      expect((await store.getThread(thread.id))?.model).toBeUndefined();

      await store.updateThread(thread.id, { model: 'gpt-fast' });
      expect(await store.modelForThread(thread.id)).toBe('gpt-fast');
      expect((await store.listThreads('actor-model'))[0]?.model).toBe('gpt-fast');
      const answer = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'q' });
      const fork = await store.forkThread(thread.id, answer.id);
      expect(fork.model).toBe('gpt-fast');

      await store.updateThread(thread.id, { model: null });
      expect(await store.modelForThread(thread.id)).toBeNull();
      expect(await store.modelForThread('missing')).toBeNull();
    });

    it('pins, reads, clears and forks the thread persona', async () => {
      const created = await store.createThread({ actor: { id: 'actor-persona' }, persona: 'sql' });
      expect(await store.personaForThread(created.id)).toBe('sql');
      expect(created.persona).toBe('sql');

      const thread = await store.createThread({ actor: { id: 'actor-persona' } });
      expect(await store.personaForThread(thread.id)).toBeNull();
      expect((await store.getThread(thread.id))?.persona).toBeNull();

      await store.updateThread(thread.id, { persona: 'read-only' });
      expect(await store.personaForThread(thread.id)).toBe('read-only');
      expect((await store.getThread(thread.id))?.persona).toBe('read-only');
      const answer = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'a',
        persona: 'read-only',
      });
      const fork = await store.forkThread(thread.id, answer.id);
      expect(fork.persona).toBe('read-only');
      expect((await store.getThread(fork.id))?.messages[0]?.persona).toBe('read-only');

      await store.updateThread(thread.id, { persona: null });
      expect(await store.personaForThread(thread.id)).toBeNull();
      expect(await store.personaForThread('missing')).toBeNull();
    });

    it('reads the default agent without materializing the thread', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-projection' } });
      expect(await store.defaultAgentForThread(thread.id)).toBeNull();

      await store.updateThread(thread.id, { defaultAgent: 'researcher' });
      expect(await store.defaultAgentForThread(thread.id)).toBe('researcher');

      expect(await store.defaultAgentForThread('missing')).toBeNull();
      await store.softDeleteThread(thread.id);
      expect(await store.defaultAgentForThread(thread.id)).toBeNull();
    });
  });

  /**
   * Every terminal the SPI can hand a store has to be NAMEABLE by the row it lands in. The
   * `satisfies` is the whole check: a `recordRunEnd` declaring a narrower parameter still accepts
   * `'cancelled'` and writes it through (method parameters are bivariant), so at runtime nothing is
   * wrong — but the row type tells every reader a cancelled run is impossible, and a reliability read
   * then has no way to leave a user pressing Stop out of its failure count.
   */
  const TERMINALS = [
    'completed',
    'failed',
    'cancelled',
  ] as const satisfies readonly (AgentRunStatus & RecordRunEndInput['status'])[];

  describe('DrizzleAgentStore — the terminals a run can settle on', () => {
    it('records and reads back each of them, leaving a cancelled run undiagnosed', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-terminals' } });

      for (const status of TERMINALS) {
        const runId = `run-${status}`;
        await store.recordRunStart({ runId, threadId: thread.id, actorRef: 'actor-terminals' });
        await store.recordRunEnd({ runId, status, durationMs: 42 });

        const [settled] = await db
          .select()
          .from(handle.t.agentRun)
          .where(eq(handle.t.agentRun.id, runId));
        expect(settled?.status).toBe(status);
        expect(settled?.durationMs).toBe(42);
      }

      // a stop is not a diagnosis — nothing to page anyone about
      const [cancelled] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-cancelled'));
      expect(cancelled?.errorCode).toBeNull();
      expect(cancelled?.errorMessage).toBeNull();
    });
  });

  describe('ensureAgentSchema (drizzle)', () => {
    it('declares an index on agent_tool_call.message_id', async () => {
      const indexes = await indexesOf(handle, 'agent_tool_call');
      expect(indexes.map((index) => index.columns[0])).toContain('message_id');
    });

    it.runIf(dialect === 'sqlite')(
      'upgrades tables an older release of this package created',
      async () => {
        const sqlite = new Database(':memory:');
        // `CREATE TABLE IF NOT EXISTS` is inert against a table that already exists, so the column and
        // the index below only ever land on a running deployment through the additive pass.
        sqlite.exec(`CREATE TABLE agent_thread (
        id TEXT PRIMARY KEY NOT NULL,
        actor_ref TEXT NOT NULL,
        tenant_ref TEXT,
        title TEXT NOT NULL,
        transient INTEGER NOT NULL DEFAULT 0,
        active_stream_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`);
        sqlite.exec(`CREATE TABLE agent_message (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_results TEXT,
        attachments TEXT,
        follow_ups TEXT,
        usage TEXT,
        agent_name TEXT,
        run_id TEXT,
        created_at INTEGER NOT NULL
      )`);
        sqlite.exec(`CREATE TABLE agent_tool_call (
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
        executed_at INTEGER,
        run_id TEXT
      )`);
        sqlite.exec(`CREATE TABLE agent_run (
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
      )`);
        const aged = drizzle(sqlite, { schema: agentSchema });

        await ensureAgentSchema(aged);

        const agedStore = new DrizzleAgentStore(aged);
        const thread = await agedStore.createThread({ actor: { id: 'actor-upgraded' } });
        await agedStore.updateThread(thread.id, { defaultAgent: 'researcher' });
        expect((await agedStore.getThread(thread.id))?.defaultAgent).toBe('researcher');

        await agedStore.recordRunStart({
          runId: 'run-child',
          threadId: thread.id,
          actorRef: 'actor-upgraded',
          parentRunId: 'run-parent',
        });
        const [run] = await aged
          .select()
          .from(handle.t.agentRun)
          .where(eq(handle.t.agentRun.id, 'run-child'));
        expect(run?.parentRunId).toBe('run-parent');

        const thought = await agedStore.appendMessage({
          threadId: thread.id,
          role: 'assistant',
          content: 'answer',
          reasoning: 'thinking',
          reasoningMs: 1200,
          ui: [{ id: 'u', component: 'stat', props: { value: 1 } }],
          persona: 'sql',
        });
        const [reloaded] = (await agedStore.getThread(thread.id))?.messages ?? [];
        expect(reloaded).toMatchObject({
          id: thought.id,
          persona: 'sql',
          reasoning: 'thinking',
          reasoningMs: 1200,
          ui: [{ id: 'u', component: 'stat', props: { value: 1 } }],
        });
        await agedStore.setMessageFeedback(thought.id, {
          value: 'up',
          updatedAt: '2026-09-01T00:00:00.000Z',
        });
        expect((await agedStore.getThread(thread.id))?.messages[0]?.feedback?.value).toBe('up');

        // The approval columns land on an existing agent_tool_call too.
        await agedStore.recordToolCall({
          toolCallId: 'aged-call',
          messageId: thought.id,
          toolName: 'purge',
          toolType: 'action',
          input: {},
          status: 'pending_approval',
          approver: 'ops',
          expiresAt: '2030-01-01T00:00:00.000Z',
        });
        expect(await agedStore.toolCallApproval('aged-call')).toEqual({
          status: 'pending_approval',
          approver: 'ops',
          expiresAt: '2030-01-01T00:00:00.000Z',
        });

        const indexes = await aged.all<{ name: string }>(
          sql.raw('PRAGMA index_list(agent_tool_call)'),
        );
        expect(indexes.map((index) => index.name)).toContain('agent_tool_call_message_idx');
      },
    );
  });

  const IMAGE = { url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' };

  describe('DrizzleAgentStore — which media a live message still references', () => {
    it('reports the referenced subset, scoped to the asking actor', async () => {
      const mine = await store.createThread({ actor: { id: 'actor-ref-1' } });
      const theirs = await store.createThread({ actor: { id: 'actor-ref-2' } });
      await store.appendMessage({
        threadId: mine.id,
        role: 'user',
        content: 'mine',
        attachments: [{ mediaId: 'mine', ...IMAGE }],
      });
      await store.appendMessage({
        threadId: theirs.id,
        role: 'user',
        content: 'theirs',
        attachments: [{ mediaId: 'theirs', ...IMAGE }],
      });

      expect(await store.referencedMediaIds('actor-ref-1', ['mine', 'theirs', 'never'])).toEqual([
        'mine',
      ]);
    });

    it('re-derives after truncateFrom, so a regenerated turn frees its media again', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-ref-3' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'look',
        attachments: [{ mediaId: 'sent', ...IMAGE }],
      });
      expect(await store.referencedMediaIds('actor-ref-3', ['sent'])).toEqual(['sent']);

      await store.truncateFrom(thread.id, message.id);

      expect(await store.referencedMediaIds('actor-ref-3', ['sent'])).toEqual([]);
    });

    it('still counts a reference held by a soft-deleted thread', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-ref-4' } });
      await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'look',
        attachments: [{ mediaId: 'kept', ...IMAGE }],
      });

      await store.softDeleteThread(thread.id);

      // The message row survives a soft delete, so the bytes it points at are not garbage yet — a
      // host that wants them collected removes the thread for real and lets the cascade do it.
      expect(await store.referencedMediaIds('actor-ref-4', ['kept'])).toEqual(['kept']);
    });

    it('carries every message field onto a fork', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-fork' } });
      const appended = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'here it is',
        ...EVERY_MESSAGE_FIELD,
      });

      const fork = await store.forkThread(thread.id, appended.id);

      const [copied] = (await store.getThread(fork.id))?.messages ?? [];
      expect(copied).toMatchObject(EVERY_MESSAGE_FIELD);
    });

    it('counts a message waiting in the thread’s queue — sent, just not run yet', async () => {
      const mine = await store.createThread({ actor: { id: 'q-1' } });
      const theirs = await store.createThread({ actor: { id: 'q-2' } });
      await store.enqueueMessage({
        threadId: mine.id,
        actor: { id: 'q-1' },
        content: 'look at this next',
        attachments: [{ mediaId: 'queued', ...IMAGE }],
      });
      await store.enqueueMessage({
        threadId: theirs.id,
        actor: { id: 'q-2' },
        content: 'theirs, waiting',
        attachments: [{ mediaId: 'queued-theirs', ...IMAGE }],
      });

      // Collecting it now would fail the turn it is waiting to start; another actor's queue stays
      // invisible, exactly like another actor's transcript.
      expect(await store.referencedMediaIds('q-1', ['queued', 'queued-theirs'])).toEqual([
        'queued',
      ]);
    });

    it('re-derives from the queue too: a removed or edited queued message frees its media', async () => {
      const thread = await store.createThread({ actor: { id: 'q-3' } });
      const removed = await store.enqueueMessage({
        threadId: thread.id,
        actor: { id: 'q-3' },
        content: 'never mind',
        attachments: [{ mediaId: 'removed', ...IMAGE }],
      });
      const edited = await store.enqueueMessage({
        threadId: thread.id,
        actor: { id: 'q-3' },
        content: 'with a picture',
        attachments: [{ mediaId: 'dropped', ...IMAGE }],
      });
      expect(await store.referencedMediaIds('q-3', ['removed', 'dropped'])).toEqual([
        'removed',
        'dropped',
      ]);

      await store.removeQueuedMessage(removed.id);
      await store.updateQueuedMessage(edited.id, { attachments: null });

      expect(await store.referencedMediaIds('q-3', ['removed', 'dropped'])).toEqual([]);
    });
  });

  /**
   * What a turn reads off a thread is a WINDOW — the last few messages, the title, and whether the
   * thread has ever been answered. `getThread` hands back the transcript instead: every message, every
   * attachment, every tool output the thread ever recorded, all of it parsed and then journaled by the
   * run. A 50-turn thread whose turns each ran a 50 KB tool is 1.9 MB of that, 97% tool results.
   */
  describe('DrizzleAgentStore — the window a turn reads off a thread', () => {
    const queries: string[] = [];
    let windowHandle: AgentDbHandle;
    let windowDb: AgentSqliteDb;
    let windowStore: DrizzleAgentStore;

    beforeAll(async () => {
      windowHandle = await openAgentDb(dialect, {
        logger: { logQuery: (query) => queries.push(query) },
      });
      windowDb = windowHandle.q;
      windowStore = new DrizzleAgentStore(windowHandle.db);
    });

    afterAll(async () => {
      await windowHandle?.close();
    });

    beforeEach(async () => {
      await windowHandle.reset();
      queries.length = 0;
    });

    /** A thread whose first message is the assistant's and whose last `count` are the user's. */
    async function threadOf(actorRef: string, count: number): Promise<ThreadSummary> {
      const thread = await windowStore.createThread({
        actor: { id: actorRef },
        title: 'Long chat',
      });
      const appended = [
        await windowStore.appendMessage({
          threadId: thread.id,
          role: 'assistant',
          content: 'the first answer',
        }),
      ];
      for (let index = 1; index <= count; index += 1) {
        appended.push(
          await windowStore.appendMessage({
            threadId: thread.id,
            role: 'user',
            content: `question ${index}`,
          }),
        );
      }
      // One second each. They are appended within the same millisecond, and the tiebreak after
      // `created_at` is a random uuid — so which two a window of two holds would be decided by chance.
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (const [index, message] of appended.entries()) {
        await windowDb
          .update(handle.t.agentMessage)
          .set({ createdAt: new Date(base + index * 1000) })
          .where(eq(handle.t.agentMessage.id, message.id));
      }
      return thread;
    }

    /** The reads that pull message CONTENT — not the one-column probe for an assistant message. */
    function transcriptReads(): string[] {
      return queries
        .map((query) => query.replaceAll('`', '"'))
        .filter((query) => /^select .*"content".*from "agent_message"/i.test(query));
    }

    it('returns the newest messages, oldest first, with the fields the turn reads off the thread', async () => {
      const thread = await threadOf('actor-window', 4);
      await windowStore.updateThread(thread.id, { defaultAgent: 'researcher' });

      const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 2 });

      expect(page?.messages.map((message) => message.content)).toEqual([
        'question 3',
        'question 4',
      ]);
      expect(page?.title).toBe('Long chat');
      expect(page?.defaultAgent).toBe('researcher');
    });

    it('counts an assistant message the window does not reach', async () => {
      // A thread-start intake asks "has this been answered before?". Answered off the PAGE, a long
      // thread whose window holds only the user's last questions re-introduces itself every turn.
      const thread = await threadOf('actor-window-assistant', 3);

      const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 2 });

      expect(page?.messages.some((message) => message.role === 'assistant')).toBe(false);
      expect(page?.hasAssistantMessage).toBe(true);
    });

    it('asks the database for the window, not for the transcript', async () => {
      const thread = await threadOf('actor-window-sql', 4);
      queries.length = 0;

      await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 2 });

      const [read] = transcriptReads();
      expect(read).toMatch(/limit/i);
      // Named columns, not `*` — the ones a model turn never reads stay in the table.
      expect(read).toMatch(/"content"/);
      expect(read).not.toMatch(/select \*/i);
      expect(read).not.toMatch(/"usage"/);
      expect(read).not.toMatch(/"follow_ups"/);
    });

    it('reads no messages at all for an empty window', async () => {
      const thread = await threadOf('actor-window-zero', 2);
      queries.length = 0;

      const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 0 });

      expect(page?.messages).toEqual([]);
      expect(page?.hasAssistantMessage).toBe(true);
      expect(transcriptReads()).toEqual([]);
    });

    it('returns the whole thread when no window is asked for', async () => {
      const thread = await threadOf('actor-window-all', 2);

      const page = await windowStore.loadThreadForTurn({ threadId: thread.id });

      expect(page?.messages.map((message) => message.content)).toEqual([
        'the first answer',
        'question 1',
        'question 2',
      ]);
    });

    it('carries the tool calls and results a message in the window recorded', async () => {
      const thread = await windowStore.createThread({ actor: { id: 'actor-window-tools' } });
      await windowStore.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'looking',
        toolCalls: [{ id: 'w1', name: 'lookup', input: {}, kind: 'read' }],
        toolResults: [{ id: 'w1', name: 'lookup', output: { rows: 2 } }],
      });

      const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 1 });

      expect(page?.messages[0]?.toolCalls).toEqual([
        { id: 'w1', name: 'lookup', input: {}, kind: 'read' },
      ]);
      expect(page?.messages[0]?.toolResults).toEqual([
        { id: 'w1', name: 'lookup', output: { rows: 2 } },
      ]);
    });

    it('has nothing to load for a thread that is unknown or soft-deleted', async () => {
      const thread = await threadOf('actor-window-gone', 1);
      expect(await windowStore.loadThreadForTurn({ threadId: 'missing' })).toBeNull();

      await windowStore.softDeleteThread(thread.id);

      expect(await windowStore.loadThreadForTurn({ threadId: thread.id })).toBeNull();
    });
  });

  /**
   * Everything `recordRunStart` is handed has to land in a column. `parentRunId` — the run that
   * delegated this one — is the case that made this check: the durable journal holds the parent edge
   * and nothing else does, so a run-row reader cannot roll a delegation's cost up to the turn that
   * asked for it, and a DETACHED child outlives its parent's turn, so the transcript cannot pair them
   * either. Typed `Required<RecordRunStartInput>` so the next field fails to COMPILE here first.
   */
  function everyRunStartField(threadId: string): Required<RecordRunStartInput> {
    return {
      runId: 'run-child',
      threadId,
      actorRef: 'actor-run-fields',
      agentName: 'researcher',
      parentRunId: 'run-parent',
      promptHash: 'a'.repeat(64),
    };
  }

  describe('DrizzleAgentStore — a recorded run round-trips every field it was started with', () => {
    it('reads all of them back off the row', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-run-fields' } });
      const started = everyRunStartField(thread.id);

      await store.recordRunStart(started);

      const [row] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, started.runId));
      expect(row).toMatchObject({
        agentName: started.agentName,
        parentRunId: started.parentRunId,
        promptHash: started.promptHash,
      });
    });

    it('leaves the parent null for a turn nobody delegated', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-run-root' } });

      await store.recordRunStart({
        runId: 'run-root',
        threadId: thread.id,
        actorRef: 'actor-run-root',
      });

      const [row] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-root'));
      expect(row?.parentRunId).toBeNull();
    });
  });

  describe('DrizzleAgentStore approvals', () => {
    it('persists who approves, until when, how it was decided, and what to remember', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-1' } });
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
      await store.recordToolCall({
        toolCallId: 'c2',
        messageId: message.id,
        toolName: 'lookup',
        toolType: 'read',
        input: {},
        status: 'auto_executed',
      });

      expect(await store.toolCallInput('c1')).toEqual({});
      expect(await store.toolCallInput('missing')).toBeNull();
      expect(await store.toolCallApproval('c1')).toEqual({
        status: 'pending_approval',
        approver: 'ops',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      expect(await store.toolCallApproval('missing')).toBeNull();
      expect((await store.getThread(thread.id))?.messages[0]?.approvals).toEqual([
        {
          toolCallId: 'c1',
          approver: 'ops',
          status: 'pending',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      ]);
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
      const other = await store.createThread({ actor: { id: 'actor-1' } });
      expect(await store.rememberedApprovals(other.id)).toEqual([]);
    });

    it('reads what a dangling call settled with, and fails the calls a dead run left waiting', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-1' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'saving',
      });
      for (const [toolCallId, status, runId] of [
        ['dead-waiting', 'pending_approval', 'run-dead'],
        ['dead-ran', 'pending_approval', 'run-dead'],
        ['live-waiting', 'pending_approval', 'run-live'],
      ] as const) {
        await store.recordToolCall({
          toolCallId,
          messageId: message.id,
          toolName: 'save',
          toolType: 'action',
          input: {},
          status,
          runId,
        });
      }
      await store.updateToolCall({ toolCallId: 'dead-ran', status: 'executed', output: { ok: 1 } });

      expect(await store.failUnsettledToolCalls('run-dead', 'the run ended')).toBe(1);
      // Only still-pending calls: a repeat changes nothing.
      expect(await store.failUnsettledToolCalls('run-dead', 'again')).toBe(0);

      const outcomes = await store.toolCallOutcomes([
        'dead-waiting',
        'dead-ran',
        'live-waiting',
        'missing',
      ]);
      expect(outcomes.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'dead-ran', status: 'executed', output: { ok: 1 } },
        { id: 'dead-waiting', status: 'failed', error: 'the run ended' },
        { id: 'live-waiting', status: 'pending_approval' },
      ]);
      expect(await store.toolCallOutcomes([])).toEqual([]);
    });
  });
  /**
   * What a real database does differently from SQLite: timestamp precision, `TEXT` caps (MySQL's is
   * 64 KB), float precision, and adding columns to a table that already holds rows.
   */
  describe('DrizzleAgentStore — what each database keeps exactly', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reads messages back in the order they were appended, even within one clock tick', async () => {
      // Every row gets the same created_at — what a fast turn produces within one millisecond.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
      const thread = await store.createThread({ actor: { id: 'tick-actor' } });
      const contents = Array.from({ length: 8 }, (_, index) => `message ${index}`);
      for (const [index, content] of contents.entries()) {
        await store.appendMessage({
          threadId: thread.id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content,
        });
      }

      const transcript = (await store.getThread(thread.id))?.messages ?? [];
      expect(transcript.map((message) => message.content)).toEqual(contents);
      const window = await store.loadThreadForTurn({ threadId: thread.id, messageLimit: 3 });
      expect(window?.messages.map((message) => message.content)).toEqual(contents.slice(-3));
      const [last] = await store.listThreads('tick-actor');
      expect(last?.lastMessagePreview).toBe('message 7');

      const fork = await store.forkThread(thread.id, transcript[5]?.id as string);
      const forked = (await store.getThread(fork.id))?.messages ?? [];
      expect(forked.map((message) => message.content)).toEqual(contents.slice(0, 6));

      await store.truncateFrom(thread.id, transcript[4]?.id as string);
      const truncated = (await store.getThread(thread.id))?.messages ?? [];
      expect(truncated.map((message) => message.content)).toEqual(contents.slice(0, 4));
    });

    it('keeps millisecond timestamps', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-04T05:06:07.123Z'));
      const thread = await store.createThread({ actor: { id: 'ms-actor' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'x',
      });
      vi.useRealTimers();

      const [read] = (await store.getThread(thread.id))?.messages ?? [];
      expect(read?.createdAt).toBe('2026-03-04T05:06:07.123Z');
      expect(read?.createdAt).toBe(message.createdAt);
      expect((await store.getThread(thread.id))?.createdAt).toBe('2026-03-04T05:06:07.123Z');
    });

    it('stores a message, a reasoning trace and a run error far past 64 KB', async () => {
      const thread = await store.createThread({ actor: { id: 'big-actor' } });
      const big = 'x'.repeat(300_000);
      await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: big,
        reasoning: big,
      });
      await store.recordRunStart({ runId: 'run-big', threadId: thread.id, actorRef: 'big-actor' });
      await store.recordRunEnd({ runId: 'run-big', status: 'failed', errorMessage: big });

      const [read] = (await store.getThread(thread.id))?.messages ?? [];
      expect(read?.content.length).toBe(big.length);
      expect(read?.reasoning?.length).toBe(big.length);
      const [run] = await db
        .select()
        .from(handle.t.agentRun)
        .where(eq(handle.t.agentRun.id, 'run-big'));
      expect(run?.errorMessage?.length).toBe(big.length);
    });

    it('keeps a fractional price and a sub-cent cost exactly', async () => {
      const pricingStore = new DrizzlePricingStore(handle.db);
      await pricingStore.upsertModelPrice({
        modelId: 'fractional',
        inputPricePer1m: 0.075,
        outputPricePer1m: 0.3,
        cacheReadPricePer1m: 0.01875,
      });
      const [price] = (await pricingStore.listCurrentPrices()).filter(
        (row) => row.modelId === 'fractional',
      );
      expect(price).toMatchObject({
        inputPricePer1m: 0.075,
        outputPricePer1m: 0.3,
        cacheReadPricePer1m: 0.01875,
      });
      const thread = await store.createThread({ actor: { id: 'cost-actor' } });
      await store.recordUsage({
        threadId: thread.id,
        actorRef: 'cost-actor',
        modelId: 'fractional',
        purpose: 'chat',
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0.000123456,
      });
      const [usage] = await db
        .select()
        .from(handle.t.agentTokenUsage)
        .where(eq(handle.t.agentTokenUsage.actorRef, 'cost-actor'));
      expect(usage?.costUsd).toBe(0.000123456);
    });

    it('tells actors apart by case, on every dialect', async () => {
      const lower = await store.createThread({ actor: { id: 'alice' }, title: 'mine' });
      await store.createThread({ actor: { id: 'ALICE' }, title: 'theirs' });

      expect((await store.listThreads('alice')).map((thread) => thread.title)).toEqual(['mine']);
      expect(await store.ownerOfThread(lower.id)).toBe('alice');
    });

    it('adds every later column back to tables that hold rows, and keeps the rows', async () => {
      const aged = await openAgentDb(dialect);
      try {
        const later: Record<string, string[]> = {
          agent_thread: ['default_agent', 'model', 'persona', 'queue_pause'],
          agent_run: ['parent_run_id'],
          agent_message: ['reasoning', 'reasoning_ms', 'ui', 'feedback', 'seq', 'persona'],
          agent_tool_call: ['approver', 'expires_at', 'remember', 'decided_via'],
        };
        const agedStore = new DrizzleAgentStore(aged.db);
        const thread = await agedStore.createThread({ actor: { id: 'old' }, title: 'Old chat' });
        await agedStore.appendMessage({ threadId: thread.id, role: 'user', content: 'old row' });
        for (const [table, columns] of Object.entries(later)) {
          for (const column of columns)
            await aged.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }

        await ensureAgentSchema(aged.db);

        for (const [table, columns] of Object.entries(later)) {
          expect(await columnsOf(aged, table)).toEqual(expect.arrayContaining(columns));
        }
        await agedStore.appendMessage({
          threadId: thread.id,
          role: 'assistant',
          content: 'new row',
        });
        await agedStore.updateThread(thread.id, { defaultAgent: 'researcher' });
        const detail = await agedStore.getThread(thread.id);
        expect(detail?.messages.map((message) => message.content)).toEqual(['old row', 'new row']);
        expect(detail?.defaultAgent).toBe('researcher');
      } finally {
        await aged.close();
      }
    });

    it('lets several replicas boot at once against an empty database', async () => {
      if (dialect === 'sqlite') return; // one in-memory connection: there is no second replica
      const empty = await openAgentDb(dialect, { ensureSchema: false });
      try {
        const replicas = [empty.db, ...(await Promise.all([1, 2, 3].map(() => empty.replica())))];
        await Promise.all(replicas.map((replica) => ensureAgentSchema(replica)));
        expect(await columnsOf(empty, 'agent_message')).toContain('seq');
      } finally {
        await empty.close();
      }
    });
  });
});
