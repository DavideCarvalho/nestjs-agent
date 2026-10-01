// Integration: MikroOrmAgentStore + ensureAgentSchema on SQLite, Postgres and MySQL (each a fresh
// database; see ./testing/real-db). Runs only under `pnpm test:db`.
import type {
  RecordRunEndInput,
  RecordRunStartInput,
  StoredMessage,
  ThreadSummary,
  UpdateThreadInput,
} from '@dudousxd/nestjs-agent-core';
import { EVERY_MESSAGE_FIELD } from '@dudousxd/nestjs-agent-testing';
import type { MikroORM } from '@mikro-orm/sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { agentManagedTables, ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentRun, type AgentRunStatus } from './entities/agent-run.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';
import { describeEachDialect, openFreshOrm } from './testing/real-db';

describeEachDialect('MikroOrmAgentStore', (dialect) => {
  let orm: MikroORM;
  let store: MikroOrmAgentStore;

  beforeAll(async () => {
    orm = await openFreshOrm(dialect, {});
    await ensureAgentSchema(orm);
    store = new MikroOrmAgentStore(orm.em);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  describe('MikroOrmAgentStore', () => {
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

      // appendMessage (user, with an image + PDF attachment)
      const userMessage = await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'Hello',
        attachments: [
          { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
          {
            mediaId: 'm2',
            url: 'https://cdn/b.pdf',
            contentType: 'application/pdf',
            name: 'b.pdf',
          },
        ],
      });
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('Hello');
      expect(userMessage.attachments).toEqual([
        { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
        { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
      ]);

      // appendMessage (assistant with tool calls + usage + agentName provenance)
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

      const toolCall = await orm.em.fork().findOne(AgentToolCall, { id: 'tc-1' });
      expect(toolCall?.status).toBe('executed');
      expect(toolCall?.output).toEqual({ result: 'sunny' });
      expect(toolCall?.executionMs).toBe(12);
      expect(toolCall?.executedByRef).toBe('worker-1');
      expect(toolCall?.executedAt).toBeInstanceOf(Date);
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
      const noRunToolCall = await orm.em.fork().findOne(AgentToolCall, { id: 'tc-no-run' });
      expect(noRunToolCall?.runId).toBeNull();

      // ownerOfThread / ownerOfToolCall resolve the owning actorRef for the authz checks
      expect(await store.ownerOfThread(thread.id)).toBe('actor-1');
      expect(await store.ownerOfToolCall('tc-1')).toBe('actor-1');
      expect(await store.ownerOfThread('missing')).toBeNull();
      expect(await store.ownerOfToolCall('missing')).toBeNull();

      // getThread → both messages in order, with tool-call data preserved
      const detail = await store.getThread(thread.id);
      expect(detail).not.toBeNull();
      const messages = detail?.messages as StoredMessage[];
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe('Hello');
      expect(messages[0]?.attachments).toEqual([
        { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
        { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
      ]);
      expect(messages[1]?.content).toBe('Looking that up');
      expect(messages[1]?.toolCalls?.[0]?.id).toBe('tc-1');
      expect(messages[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(messages[1]?.agentName).toBe('researcher');
      expect(detail?.lastMessagePreview).toBe('Looking that up');

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
        costUsd: 0.0125,
      });
      const quota = await store.quotaToday('actor-1', today);
      expect(quota.usedTokens).toBe(42);
      // the same ledger over a range: a month that holds today counts it, one that ends before does not
      expect(
        (await store.usageBetween('actor-1', `${today.slice(0, 8)}01`, today)).usedTokens,
      ).toBe(42);
      expect((await store.usageBetween('actor-1', '2000-01-01', '2000-01-31')).usedTokens).toBe(0);
      // costUsd sums only the rows that reported a cost (the first recordUsage had none)
      expect(quota.costUsd).toBeCloseTo(0.0125);
      const otherQuota = await store.quotaToday('actor-2', today);
      expect(otherQuota.usedTokens).toBe(0);
      expect(otherQuota.costUsd).toBe(0);

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
      expect(await orm.em.fork().findOne(AgentToolCall, { id: 'tc-1' })).toBeNull();

      // listThreads sees both threads before soft delete
      const before: ThreadSummary[] = await store.listThreads('actor-1');
      expect(before.map((t) => t.id).sort()).toEqual([thread.id, fork.id].sort());

      // softDeleteThread → getThread null + excluded from listThreads
      await store.softDeleteThread(thread.id);
      expect(await store.getThread(thread.id)).toBeNull();
      const after = await store.listThreads('actor-1');
      expect(after.map((t) => t.id)).toEqual([fork.id]);
    });

    it('resolves the owning actorRef for an active stream by runId', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-stream' } });
      await store.setActiveStream(thread.id, 'run-xyz');

      expect(await store.ownerOfActiveStream('run-xyz')).toBe('actor-stream');
      expect(await store.ownerOfActiveStream('missing')).toBeNull();
    });

    it('activeRunForThread reads the same activeStreamId setActiveStream writes', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-active' } });
      expect(await store.activeRunForThread(thread.id)).toBeNull();

      await store.setActiveStream(thread.id, 'run-abc');
      expect(await store.activeRunForThread(thread.id)).toBe('run-abc');

      await store.setActiveStream(thread.id, null);
      expect(await store.activeRunForThread(thread.id)).toBeNull();

      expect(await store.activeRunForThread('missing')).toBeNull();
    });

    it('updateThread patches title and/or defaultAgent, leaving omitted fields untouched', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-update' }, title: 'Original' });
      const readDefaultAgent = async () =>
        (await orm.em.fork().findOne(AgentThread, { id: thread.id }))?.defaultAgent;

      // title only — defaultAgent stays unset (NULL, since it was never set on create)
      await store.updateThread(thread.id, { title: 'Renamed' });
      expect((await store.getThread(thread.id))?.title).toBe('Renamed');
      expect(await readDefaultAgent()).toBeNull();

      // defaultAgent only — title from the previous patch is preserved
      await store.updateThread(thread.id, { defaultAgent: 'researcher' });
      expect((await store.getThread(thread.id))?.title).toBe('Renamed');
      expect(await readDefaultAgent()).toBe('researcher');

      // explicit null clears defaultAgent
      await store.updateThread(thread.id, { defaultAgent: null });
      expect(await readDefaultAgent()).toBeNull();

      // both fields in one patch
      await store.updateThread(thread.id, { title: 'Both', defaultAgent: 'billing-agent' });
      expect((await store.getThread(thread.id))?.title).toBe('Both');
      expect(await readDefaultAgent()).toBe('billing-agent');

      // unknown thread is a silent no-op
      await expect(store.updateThread('missing', { title: 'x' })).resolves.toBeUndefined();
    });

    it('promotes a transient thread so it surfaces in listThreads', async () => {
      const transient = await store.createThread({ actor: { id: 'actor-p' }, transient: true });
      expect(transient.transient).toBe(true);
      // a transient thread is hidden from history until promoted
      expect(await store.listThreads('actor-p')).toHaveLength(0);

      await store.promoteThread(transient.id);
      const listed = await store.listThreads('actor-p');
      expect(listed.map((t) => t.id)).toEqual([transient.id]);
      expect(listed[0]?.transient).toBe(false);

      // idempotent: promoting an already-persistent thread is a no-op
      await store.promoteThread(transient.id);
      expect(await store.listThreads('actor-p')).toHaveLength(1);
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
      const started = await orm.em.fork().findOne(AgentRun, { id: 'run-1' });
      expect(started?.status).toBe('running');
      expect(started?.retries).toBe(0);
      expect(started?.agentName).toBe('researcher');
      expect(started?.settledAt).toBeNull();
      expect(started?.promptHash).toBe('abc123def456');

      // bumpRunRetries increments without a read-modify-write race (nativeUpdate `retries + 1`)
      await store.bumpRunRetries('run-1');
      await store.bumpRunRetries('run-1');
      const bumped = await orm.em.fork().findOne(AgentRun, { id: 'run-1' });
      expect(bumped?.retries).toBe(2);

      await store.recordRunEnd({
        runId: 'run-1',
        status: 'completed',
        durationMs: 1_234,
      });
      const settled = await orm.em.fork().findOne(AgentRun, { id: 'run-1' });
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
      const failed = await orm.em.fork().findOne(AgentRun, { id: 'run-2' });
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

    it('supersedes the current price row on upsert, keeping exactly one current row per model', async () => {
      const pricingStore = new MikroOrmPricingStore(orm.em);

      await pricingStore.upsertModelPrice({
        modelId: 'm',
        inputPricePer1m: 3,
        outputPricePer1m: 15,
      });
      const firstPrices = await pricingStore.listCurrentPrices();
      const first = firstPrices.filter((price) => price.modelId === 'm');
      expect(first).toHaveLength(1);
      expect(first[0]?.inputPricePer1m).toBe(3);
      expect(first[0]?.outputPricePer1m).toBe(15);

      await pricingStore.upsertModelPrice({
        modelId: 'm',
        inputPricePer1m: 4,
        outputPricePer1m: 16,
      });
      const secondPrices = await pricingStore.listCurrentPrices();
      const second = secondPrices.filter((price) => price.modelId === 'm');
      expect(second).toHaveLength(1);
      expect(second[0]?.inputPricePer1m).toBe(4);
      expect(second[0]?.outputPricePer1m).toBe(16);
    });
  });

  describe('ensureAgentSchema (fingerprint-gated autoSchema)', () => {
    it('creates the agent tables + marker on a fresh DB and no-ops on the second call', async () => {
      const fresh = await openFreshOrm(dialect, {});
      try {
        await ensureAgentSchema(fresh);
        // marker row written with the applied fingerprint
        const first = await fresh.em
          .getConnection()
          .execute<{ fingerprint: string }[]>(
            "select fingerprint from agent_schema_meta where id = 'agent'",
          );
        expect(first[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

        // the store works against the auto-created schema
        const store = new MikroOrmAgentStore(fresh.em);
        const thread = await store.createThread({ actor: { id: 'a' }, title: 'auto' });
        expect((await store.getThread(thread.id))?.title).toBe('auto');

        // second call is a no-op (fingerprint matches) — same marker, no throw from re-created indexes
        await ensureAgentSchema(fresh);
        const second = await fresh.em
          .getConnection()
          .execute<{ fingerprint: string }[]>(
            "select fingerprint from agent_schema_meta where id = 'agent'",
          );
        expect(second[0]?.fingerprint).toBe(first[0]?.fingerprint);
      } finally {
        await fresh.close(true);
      }
    });
  });

  describe('agentSchemaSql', () => {
    it('renders create-only DDL for every managed table, applying `if not exists` to tables', async () => {
      const statements = await agentSchemaSql(orm);
      const joined = statements.join('\n');
      for (const table of [
        'agent_thread',
        'agent_message',
        'agent_tool_call',
        'agent_token_usage',
        'agent_model_pricing',
        'agent_run',
        'rag_ingestion_log',
      ]) {
        expect(joined).toContain(table);
      }
      const creates = statements.filter((sql) => /^create table/i.test(sql));
      // pinned to the managed-table set, so adding an entity without updating it can't slip through
      expect(creates).toHaveLength(agentManagedTables().length);
      // every create table is guarded; indexes stay plain (MySQL has no `create index if not exists`)
      expect(creates.every((sql) => /^create table if not exists/i.test(sql))).toBe(true);
      // MySQL renders an index as `alter table … add index`, everyone else as `create index`.
      expect(statements.some((sql) => /^create index|\badd index\b/i.test(sql))).toBe(true);
    });

    it('opts out of `if not exists` when asked, and the statements build a working schema', async () => {
      const statements = await agentSchemaSql(orm, { ifNotExists: false });
      expect(statements.every((sql) => !/if not exists/i.test(sql))).toBe(true);

      // Apply the generated DDL against an isolated database and confirm the store works on it.
      const fresh = await openFreshOrm(dialect, {});
      try {
        for (const sql of await agentSchemaSql(fresh, { ifNotExists: false })) {
          await fresh.em.getConnection().execute(sql);
        }
        const freshStore = new MikroOrmAgentStore(fresh.em);
        const thread = await freshStore.createThread({ actor: { id: 'a' }, title: 'built' });
        expect((await freshStore.getThread(thread.id))?.title).toBe('built');
      } finally {
        await fresh.close(true);
      }
    });
  });

  describe('MikroOrmAgentStore — a turn a client reads back', () => {
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

      const stored = (await store.getThread(thread.id))?.messages.find(
        (candidate) => candidate.id === message.id,
      );
      // The message's own list, in the order the turn settled it — not one re-derived from the
      // tool-call rows, whose order is their own and whose shape for a rejection is not this one.
      expect(stored?.toolResults).toEqual([
        { id: 'c1', name: 'lookup', output: { rows: 1 } },
        { id: 'c2', name: 'retrieve', output: { passages: [] } },
      ]);
    });

    it('completes a message that carries calls and no results of its own from their rows', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-1' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'looking',
        toolCalls: [{ id: 'orphan-1', name: 'lookup', input: {}, kind: 'read' }],
      });
      await store.recordToolCall({
        toolCallId: 'orphan-1',
        messageId: message.id,
        toolName: 'lookup',
        toolType: 'read',
        input: {},
        status: 'auto_executed',
      });
      await store.updateToolCall({
        toolCallId: 'orphan-1',
        status: 'executed',
        output: { rows: 2 },
      });

      const stored = (await store.getThread(thread.id))?.messages.find(
        (candidate) => candidate.id === message.id,
      );
      expect(stored?.toolResults).toEqual([
        { id: 'orphan-1', name: 'lookup', output: { rows: 2 } },
      ]);
    });
  });

  describe('MikroOrmAgentStore — feedback on a message', () => {
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

  describe('MikroOrmAgentStore — a thread patch a client reads back', () => {
    /**
     * Typed `Required<UpdateThreadInput>` so a new field on the patch fails to COMPILE here until this
     * adapter round-trips it. The column and the write existed; `toSummary` never emitted the value,
     * so `getThread` reported no default agent and a turn fell back to the module's.
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

    it('reports a never-set default agent as null, and clears it on an explicit null', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-patch-2' } });
      expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

      await store.updateThread(thread.id, { defaultAgent: 'researcher' });
      expect((await store.getThread(thread.id))?.defaultAgent).toBe('researcher');

      await store.updateThread(thread.id, { defaultAgent: null });
      expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();
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
   * wrong — but the entity tells every reader a cancelled run is impossible, and a reliability read
   * then has no way to leave a user pressing Stop out of its failure count.
   */
  const TERMINALS = [
    'completed',
    'failed',
    'cancelled',
  ] as const satisfies readonly (AgentRunStatus & RecordRunEndInput['status'])[];

  describe('MikroOrmAgentStore — the terminals a run can settle on', () => {
    it('records and reads back each of them', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-terminals' } });

      for (const status of TERMINALS) {
        const runId = `run-${status}`;
        await store.recordRunStart({ runId, threadId: thread.id, actorRef: 'actor-terminals' });
        await store.recordRunEnd({ runId, status, durationMs: 42 });

        const settled = await orm.em.fork().findOne(AgentRun, { id: runId });
        expect(settled?.status).toBe(status);
        expect(settled?.durationMs).toBe(42);
      }
    });

    it('leaves a cancelled run undiagnosed — a stop is not an error', async () => {
      const cancelled = await orm.em.fork().findOne(AgentRun, { id: 'run-cancelled' });
      expect(cancelled?.errorCode).toBeNull();
      expect(cancelled?.errorMessage).toBeNull();
    });
  });

  describe('agent_tool_call.message_id is indexed', () => {
    it('renders an index on the column the message-scoped reads run against', async () => {
      // `loadToolResults`' IN (…) and `truncateFrom`'s delete both filter on this column. MikroORM
      // indexes a many-to-one for you on MySQL and SQLite but not on Postgres — this spec used to say
      // otherwise and only ever ran on SQLite — so the entity declares the index itself.
      const statements = await agentSchemaSql(orm, { ifNotExists: false });
      expect(
        statements.some(
          (sql) =>
            /^create index|\badd index\b/i.test(sql) &&
            /agent_tool_call/.test(sql) &&
            /message_id/.test(sql),
        ),
      ).toBe(true);
    });
  });

  const IMAGE = { url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' };

  describe('MikroOrmAgentStore — which media a live message still references', () => {
    it('reports the referenced subset, scoped to the asking actor', async () => {
      const mine = await store.createThread({ actor: { id: 'actor-ref-1' } });
      const theirs = await store.createThread({ actor: { id: 'actor-ref-2' } });
      await store.appendMessage({
        threadId: mine.id,
        role: 'user',
        content: 'mine',
        attachments: [{ mediaId: 'ref-mine', ...IMAGE }],
      });
      await store.appendMessage({
        threadId: theirs.id,
        role: 'user',
        content: 'theirs',
        attachments: [{ mediaId: 'ref-theirs', ...IMAGE }],
      });

      expect(
        await store.referencedMediaIds('actor-ref-1', ['ref-mine', 'ref-theirs', 'ref-never']),
      ).toEqual(['ref-mine']);
    });

    it('re-derives after truncateFrom, so a regenerated turn frees its media again', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-ref-3' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'look',
        attachments: [{ mediaId: 'ref-sent', ...IMAGE }],
      });
      expect(await store.referencedMediaIds('actor-ref-3', ['ref-sent'])).toEqual(['ref-sent']);

      await store.truncateFrom(thread.id, message.id);

      expect(await store.referencedMediaIds('actor-ref-3', ['ref-sent'])).toEqual([]);
    });

    it('still counts a reference held by a soft-deleted thread', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-ref-4' } });
      await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'look',
        attachments: [{ mediaId: 'ref-kept', ...IMAGE }],
      });

      await store.softDeleteThread(thread.id);

      // The message row survives a soft delete, so the bytes it points at are not garbage yet — a
      // host that wants them collected removes the thread for real and lets the cascade do it.
      expect(await store.referencedMediaIds('actor-ref-4', ['ref-kept'])).toEqual(['ref-kept']);
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
      const mine = await store.createThread({ actor: { id: 'ref-q-1' } });
      const theirs = await store.createThread({ actor: { id: 'ref-q-2' } });
      await store.enqueueMessage({
        threadId: mine.id,
        actor: { id: 'ref-q-1' },
        content: 'look at this next',
        attachments: [{ mediaId: 'ref-queued', ...IMAGE }],
      });
      await store.enqueueMessage({
        threadId: theirs.id,
        actor: { id: 'ref-q-2' },
        content: 'theirs, waiting',
        attachments: [{ mediaId: 'ref-queued-theirs', ...IMAGE }],
      });

      // Collecting it now would fail the turn it is waiting to start; another actor's queue stays
      // invisible, exactly like another actor's transcript.
      expect(
        await store.referencedMediaIds('ref-q-1', ['ref-queued', 'ref-queued-theirs']),
      ).toEqual(['ref-queued']);
    });

    it('re-derives from the queue too: a removed or edited queued message frees its media', async () => {
      const thread = await store.createThread({ actor: { id: 'ref-q-3' } });
      const removed = await store.enqueueMessage({
        threadId: thread.id,
        actor: { id: 'ref-q-3' },
        content: 'never mind',
        attachments: [{ mediaId: 'ref-removed', ...IMAGE }],
      });
      const edited = await store.enqueueMessage({
        threadId: thread.id,
        actor: { id: 'ref-q-3' },
        content: 'with a picture',
        attachments: [{ mediaId: 'ref-dropped', ...IMAGE }],
      });
      expect(await store.referencedMediaIds('ref-q-3', ['ref-removed', 'ref-dropped'])).toEqual([
        'ref-removed',
        'ref-dropped',
      ]);

      await store.removeQueuedMessage(removed.id);
      await store.updateQueuedMessage(edited.id, { attachments: null });

      expect(await store.referencedMediaIds('ref-q-3', ['ref-removed', 'ref-dropped'])).toEqual([]);
    });
  });

  /**
   * What a turn reads off a thread is a WINDOW — the last few messages, the title, and whether the
   * thread has ever been answered. `getThread` hands back the transcript instead: every message, every
   * attachment, every tool output the thread ever recorded, all of it parsed and then journaled by the
   * run. A 50-turn thread whose turns each ran a 50 KB tool is 1.9 MB of that, 97% tool results.
   */
  describe('MikroOrmAgentStore — the window a turn reads off a thread', () => {
    let windowOrm: MikroORM;
    let windowStore: MikroOrmAgentStore;
    const queries: string[] = [];

    beforeAll(async () => {
      windowOrm = await openFreshOrm(dialect, {
        debug: ['query'],
        logger: (message) => queries.push(message),
      });
      await ensureAgentSchema(windowOrm);
      windowStore = new MikroOrmAgentStore(windowOrm.em);
    });

    afterAll(async () => {
      await windowOrm?.close(true);
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
      const em = windowOrm.em.fork();
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (const [index, message] of appended.entries()) {
        await em.nativeUpdate(
          AgentMessage,
          { id: message.id },
          { createdAt: new Date(base + index * 1000) },
        );
      }
      return thread;
    }

    /** The reads that pull message CONTENT — not the one-column count of assistant messages. */
    /** The logged message reads, identifiers re-quoted MySQL-style so one pattern fits every dialect. */
    function transcriptReads(): string[] {
      return queries
        .map((query) => query.replaceAll('"', '`'))
        .filter((query) => /select .*`content`.*from `agent_message`/i.test(query));
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
      // Named columns, not `a0`.* — the ones a model turn never reads stay in the table.
      expect(read).toMatch(/`content`/);
      expect(read).not.toMatch(/`a0`\.\*/);
      expect(read).not.toMatch(/`usage`/);
      expect(read).not.toMatch(/`follow_ups`/);
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

    it('carries the tool results of a message inside the window', async () => {
      const thread = await windowStore.createThread({ actor: { id: 'actor-window-tools' } });
      const message = await windowStore.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'looking',
        toolCalls: [{ id: 'w1', name: 'lookup', input: {}, kind: 'read' }],
      });
      await windowStore.recordToolCall({
        toolCallId: 'w1',
        messageId: message.id,
        toolName: 'lookup',
        toolType: 'read',
        input: {},
        status: 'auto_executed',
      });
      await windowStore.updateToolCall({
        toolCallId: 'w1',
        status: 'executed',
        output: { rows: 2 },
      });

      const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 1 });

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

  describe('MikroOrmAgentStore — a recorded run round-trips every field it was started with', () => {
    it('reads all of them back off the row', async () => {
      const thread = await store.createThread({ actor: { id: 'actor-run-fields' } });
      const started = everyRunStartField(thread.id);

      await store.recordRunStart(started);

      const em = orm.em.fork();
      expect(await em.findOne(AgentRun, { id: started.runId })).toMatchObject({
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

      const em = orm.em.fork();
      expect((await em.findOne(AgentRun, { id: 'run-root' }))?.parentRunId ?? null).toBeNull();
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
   * What a real database does differently from SQLite: timestamp precision (MySQL's `datetime` is
   * whole seconds), `TEXT` caps (MySQL's is 64 KB), single-precision `float`.
   */
  describe('MikroOrmAgentStore — what each database keeps exactly', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reads messages back in the order they were appended, even within one clock tick', async () => {
      // Every row gets the same created_at: what MySQL's whole-second datetime made of a turn's
      // assistant + tool messages, and what a fast turn produces within one millisecond anywhere.
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

    it('keeps sub-second timestamps', async () => {
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
      const run = await orm.em.fork().findOne(AgentRun, { id: 'run-big' });
      expect(run?.errorMessage?.length).toBe(big.length);
    });

    it('tells actors apart by case, on every dialect', async () => {
      const lower = await store.createThread({ actor: { id: 'case-alice' }, title: 'mine' });
      await store.createThread({ actor: { id: 'CASE-ALICE' }, title: 'theirs' });

      expect((await store.listThreads('case-alice')).map((thread) => thread.title)).toEqual([
        'mine',
      ]);
      expect(await store.ownerOfThread(lower.id)).toBe('case-alice');
    });

    it('keeps a fractional price and a sub-cent cost exactly', async () => {
      const pricingStore = new MikroOrmPricingStore(orm.em);
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
      const [usage] = await orm.em.fork().find(AgentTokenUsage, { actorRef: 'cost-actor' });
      expect(usage?.costUsd).toBe(0.000123456);
    });
  });
});
