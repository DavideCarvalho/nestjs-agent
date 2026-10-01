import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateActionProposal } from '@dudousxd/nestjs-agent-core';
import {
  ACTION_PROPOSAL_STORE_CONTRACT,
  ACTION_PROPOSAL_WORKER_STORE_CONTRACT,
} from '@dudousxd/nestjs-agent-testing';
import { IsolationLevel } from '@mikro-orm/core';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { MikroOrmActionProposals } from './mikro-orm-action-proposals';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { type AgentOrmHandle, describeEachDialect, openAgentOrm, rawSql } from './testing/real-db';

const scope = { tenantRef: null, actorRef: 'owner', threadId: 'thread' };
const proposal = (id = 'proposal'): CreateActionProposal => ({
  ...scope,
  id,
  originRunId: 'run',
  originMessageId: 'message',
  originToolCallId: 'call',
  toolName: 'refund',
  input: { amount: 5 },
  confirmation: { title: 'Refund?', verb: 'Refund' },
  approver: 'requester',
  expiresAt: 2000,
  idempotencyKey: `key:${id}`,
});
const approve = { decision: 'approved', actorRef: 'reviewer', via: 'http' } as const;

describeEachDialect('MikroOrmAgentStore action proposals', (dialect) => {
  let handle: AgentOrmHandle;
  let replica: MikroORM;
  let directory: string | undefined;
  let now = 1000;
  let store: MikroOrmAgentStore;
  let peer: MikroOrmAgentStore;
  beforeAll(async () => {
    directory =
      dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'agent-proposals-')) : undefined;
    const dbName = directory === undefined ? undefined : join(directory, 'proposals.sqlite');
    handle = await openAgentOrm(dialect, dbName === undefined ? {} : { config: { dbName } });
    replica =
      dbName === undefined
        ? await handle.replica()
        : await MikroORM.init({
            driver: SqliteDriver,
            dbName,
            entities: agentEntities(),
            allowGlobalContext: true,
          });
    store = new MikroOrmAgentStore(handle.orm.em, { clock: () => now });
    peer = new MikroOrmAgentStore(replica.em, { clock: () => now });
  });
  afterAll(async () => {
    if (directory !== undefined) await replica?.close(true);
    await handle?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });
  async function fresh() {
    if (typeof store.createActionProposal === 'function')
      await rawSql(handle.orm, 'delete from agent_action_proposal');
    now = 1000;
    return {
      store,
      setNow: (value: number) => {
        now = value;
      },
    };
  }
  for (const contract of ACTION_PROPOSAL_STORE_CONTRACT) {
    it(contract.name, async () => contract.run(await fresh()));
  }
  for (const contract of ACTION_PROPOSAL_WORKER_STORE_CONTRACT) {
    it(contract.name, async () => contract.run(await fresh()));
  }
  it('claims queued work across scopes through independent connections and returns each winning fence', async () => {
    await fresh();
    for (const data of [
      proposal('a'),
      { ...proposal('b'), actorRef: 'other', tenantRef: 'tenant', threadId: 'other-thread' },
    ]) {
      await store.createActionProposal(data);
      await store.decideActionProposal(data, data.id, approve);
    }
    const rows = await Promise.all([
      store.claimNextActionProposal({ workerId: 'a', leaseMs: 100 }),
      peer.claimNextActionProposal({ workerId: 'b', leaseMs: 100 }),
    ]);
    expect(
      rows
        .filter(Boolean)
        .map((row) => row?.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(rows[0]?.execution?.lease?.workerId).toBe('a');
    expect(rows[1]?.execution?.lease?.workerId).toBe('b');
    expect(await store.claimNextActionProposal({ workerId: 'third', leaseMs: 100 })).toBeNull();
    expect(await store.getActionProposal(scope, 'b')).toBeNull();
  });
  it('uses current indexed lease metadata for renewal, boundary recovery and settlement', async () => {
    await fresh();
    await store.createActionProposal(proposal());
    await store.decideActionProposal(scope, 'proposal', approve);
    const first = await store.claimNextActionProposal({ workerId: 'first', leaseMs: 100 });
    const firstLease = first?.execution?.lease;
    if (!firstLease) throw new Error('Expected lease');
    now = 1050;
    await peer.extendActionProposalLease(scope, 'proposal', { ...firstLease, leaseMs: 200 });
    now = 1100;
    expect(await store.claimNextActionProposal({ workerId: 'early', leaseMs: 100 })).toBeNull();
    now = 1250;
    const winners = await Promise.all([
      store.claimNextActionProposal({ workerId: 'recovery-a', leaseMs: 100 }),
      peer.claimNextActionProposal({ workerId: 'recovery-b', leaseMs: 100 }),
    ]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const recovered = winners.find(Boolean);
    expect(recovered?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(recovered?.execution?.generation).toBe(2);
    const lease = recovered?.execution?.lease;
    if (!lease) throw new Error('Expected recovery lease');
    expect(
      (await peer.settleActionProposal(scope, 'proposal', { ...firstLease, status: 'succeeded' }))
        .status,
    ).toBe('conflict');
    await store.settleActionProposal(scope, 'proposal', { ...lease, status: 'succeeded' });
    now = 2000;
    expect(await peer.claimNextActionProposal({ workerId: 'settled', leaseMs: 100 })).toBeNull();
  });
  it('expires due pending rows in SQL-bounded batches with one cross-connection winner', async () => {
    await fresh();
    for (const id of ['a', 'b', 'approved']) await store.createActionProposal(proposal(id));
    await store.decideActionProposal(scope, 'approved', approve);
    expect(await store.expireActionProposals({ limit: 1 })).toBe(0);
    now = 2000;
    const results = await Promise.all([
      store.expireActionProposals({ limit: 1 }),
      peer.expireActionProposals({ limit: 1 }),
    ]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1);
    expect(results.every((count) => count <= 1)).toBe(true);
    await store.expireActionProposals({ limit: 100 });
    expect((await store.getActionProposal(scope, 'a'))?.decisionAudit).toEqual({
      actorRef: 'system',
      via: 'expiry',
      at: 2000,
    });
    expect((await store.getActionProposal(scope, 'b'))?.decision).toBe('expired');
    expect((await store.getActionProposal(scope, 'approved'))?.decision).toBe('approved');
  });
  it('bounds the indexed candidate query and failed claim attempts to 32', async () => {
    await fresh();
    for (let index = 0; index < 40; index++) {
      const data = proposal(`candidate-${index.toString().padStart(2, '0')}`);
      await store.createActionProposal(data);
      await store.decideActionProposal(data, data.id, approve);
    }
    const candidates = vi.spyOn(handle.orm.em.getDriver(), 'find');
    const claims = vi
      .spyOn(MikroOrmActionProposals.prototype, 'claimActionProposal')
      .mockResolvedValue({ status: 'conflict' });
    try {
      expect(await store.claimNextActionProposal({ workerId: 'racing', leaseMs: 100 })).toBeNull();
      expect(claims).toHaveBeenCalledTimes(32);
      expect(candidates.mock.calls.some((call) => call[2]?.limit === 32)).toBe(true);
      expect(candidates.mock.calls[0]?.[1]).toMatchObject({
        discoveryIndexVersion: 1,
        decision: 'approved',
      });
    } finally {
      claims.mockRestore();
      candidates.mockRestore();
    }
  });
  it('validates worker commands and clock before an empty candidate query', async () => {
    await fresh();
    for (const leaseMs of [0, -1, 0.5, Number.MAX_SAFE_INTEGER])
      await expect(
        store.claimNextActionProposal({ workerId: 'worker', leaseMs }),
      ).rejects.toThrow();
    await expect(peer.claimNextActionProposal({ workerId: '', leaseMs: 100 })).rejects.toThrow();
    for (const limit of [0, -1, 0.5, 1001, Number.NaN]) {
      await expect(store.expireActionProposals({ limit })).rejects.toThrow();
      await expect(store.backfillActionProposalDiscoveryIndex({ limit })).rejects.toThrow();
    }
    now = Number.NaN;
    await expect(
      peer.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 }),
    ).rejects.toThrow('clock');
    await expect(store.expireActionProposals({ limit: 1 })).rejects.toThrow('clock');
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(0);
  });
  it('backfills legacy projections in bounded fenced batches while preserving payload and audit', async () => {
    await fresh();
    for (const id of ['a', 'b', 'pending']) await store.createActionProposal(proposal(id));
    for (const id of ['a', 'b']) await store.decideActionProposal(scope, id, approve);
    const before = await store.listActionProposals(scope);
    await rawSql(
      handle.orm,
      'update agent_action_proposal set discovery_index_version = 0, execution_status = null, lease_expires_at = null, proposal_expires_at = null',
    );
    expect(
      await store.claimNextActionProposal({ workerId: 'before-backfill', leaseMs: 100 }),
    ).toBeNull();
    const results = await Promise.all([
      store.backfillActionProposalDiscoveryIndex({ limit: 1 }),
      peer.backfillActionProposalDiscoveryIndex({ limit: 1 }),
    ]);
    expect(results.every((count) => count <= 1)).toBe(true);
    while (await store.backfillActionProposalDiscoveryIndex({ limit: 1 })) {}
    expect(await store.listActionProposals(scope)).toEqual(before);
    expect(
      (await peer.claimNextActionProposal({ workerId: 'after-backfill', leaseMs: 100 }))?.id,
    ).toBe('a');
    now = 2000;
    expect(await store.expireActionProposals({ limit: 1 })).toBe(1);
    expect((await peer.getActionProposal(scope, 'pending'))?.decision).toBe('expired');
  });
  it('fences a stale backfill against a concurrently acquired lease', async () => {
    await fresh();
    await store.createActionProposal(proposal());
    await store.decideActionProposal(scope, 'proposal', approve);
    await rawSql(
      handle.orm,
      'update agent_action_proposal set discovery_index_version = 0, execution_status = null',
    );
    const driver = handle.orm.em.getDriver();
    const original = driver.nativeUpdate.bind(driver);
    const updates = vi.spyOn(driver, 'nativeUpdate').mockImplementationOnce(async (...args) => {
      expect(
        (
          await peer.claimActionProposal(scope, 'proposal', {
            workerId: 'current-writer',
            leaseMs: 100,
          })
        ).status,
      ).toBe('applied');
      return original(...args);
    });
    try {
      expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(0);
      const rows = await rawSql<
        {
          execution_status: string;
          lease_expires_at: number | string;
          discovery_index_version: number;
        }[]
      >(
        handle.orm,
        'select execution_status, lease_expires_at, discovery_index_version from agent_action_proposal',
      );
      expect(rows[0]?.execution_status).toBe('executing');
      expect(Number(rows[0]?.lease_expires_at)).toBe(1100);
      expect(rows[0]?.discovery_index_version).toBe(1);
      expect(
        await store.claimNextActionProposal({ workerId: 'too-early', leaseMs: 100 }),
      ).toBeNull();
    } finally {
      updates.mockRestore();
    }
  });
  it('adds discovery columns and indexes to legacy proposal tables without changing payloads', async () => {
    await fresh();
    for (const id of ['queued', 'executing', 'pending'])
      await store.createActionProposal(proposal(id));
    for (const id of ['queued', 'executing']) await store.decideActionProposal(scope, id, approve);
    await store.claimActionProposal(scope, 'executing', {
      workerId: 'legacy-worker',
      leaseMs: 100,
    });
    const before = await store.listActionProposals(scope);
    for (const index of [
      'agent_proposal_work_lease_idx',
      'agent_proposal_pending_expiry_idx',
      'agent_proposal_discovery_version_idx',
    ]) {
      await rawSql(
        handle.orm,
        dialect === 'mysql'
          ? `drop index ${index} on agent_action_proposal`
          : `drop index ${index}`,
      );
    }
    for (const column of ['proposal_expires_at', 'discovery_index_version'])
      await rawSql(handle.orm, `alter table agent_action_proposal drop column ${column}`);
    await rawSql(
      handle.orm,
      "update agent_schema_meta set fingerprint = 'legacy-worker-proposals'",
    );
    await ensureAgentSchema(handle.orm);
    await ensureAgentSchema(handle.orm);
    expect(await store.listActionProposals(scope)).toEqual(before);
    expect(
      await store.claimNextActionProposal({ workerId: 'before-backfill', leaseMs: 100 }),
    ).toBeNull();
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 2 })).toBe(2);
    expect(await peer.backfillActionProposalDiscoveryIndex({ limit: 2 })).toBe(1);
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 2 })).toBe(0);
    expect(await store.listActionProposals(scope)).toEqual(before);
    now = 2000;
    expect(await store.expireActionProposals({ limit: 1 })).toBe(1);
    const recovered = await Promise.all([
      store.claimNextActionProposal({ workerId: 'new-a', leaseMs: 100 }),
      peer.claimNextActionProposal({ workerId: 'new-b', leaseMs: 100 }),
    ]);
    expect(
      recovered
        .filter(Boolean)
        .map((row) => row?.id)
        .sort(),
    ).toEqual(['executing', 'queued']);
    expect(recovered.find((row) => row?.id === 'executing')?.execution?.generation).toBe(2);
  });
  it('reports one creator across independent connections at the same clock instant', async () => {
    await fresh();
    const results = await Promise.all([
      store.createActionProposal(proposal()),
      peer.createActionProposal(proposal()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['created', 'unchanged']);
    expect((await peer.createActionProposal(proposal())).status).toBe('unchanged');
  });
  it('rejects invalid list bounds', async () => {
    await fresh();
    for (const limit of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.listActionProposals(scope, { limit })).rejects.toThrow('limit');
    }
  });
  it('rejects invalid runtime decision filters', async () => {
    await fresh();
    for (const decision of ['', null, 'bad']) {
      const query = JSON.parse(JSON.stringify({ decision }));
      await expect(store.listActionProposals(scope, query)).rejects.toThrow('decision');
    }
  });
  it('keeps approval and queued execution atomic when the database rejects the update', async () => {
    await fresh();
    await store.createActionProposal(proposal());
    const install =
      dialect === 'sqlite'
        ? "create trigger reject_proposal_approval before update on agent_action_proposal when new.decision = 'approved' begin select raise(abort, 'rejected proposal update'); end"
        : "alter table agent_action_proposal add constraint reject_proposal_approval check (decision <> 'approved')";
    const remove =
      dialect === 'sqlite'
        ? 'drop trigger reject_proposal_approval'
        : dialect === 'mysql'
          ? 'alter table agent_action_proposal drop check reject_proposal_approval'
          : 'alter table agent_action_proposal drop constraint reject_proposal_approval';
    await rawSql(handle.orm, install);
    try {
      await expect(peer.decideActionProposal(scope, 'proposal', approve)).rejects.toThrow();
      expect(await store.getActionProposal(scope, 'proposal')).toMatchObject({
        decision: 'pending',
        decisionAudit: null,
        execution: null,
      });
    } finally {
      await rawSql(handle.orm, remove);
    }
    expect((await peer.decideActionProposal(scope, 'proposal', approve)).proposal).toMatchObject({
      decision: 'approved',
      execution: { status: 'queued' },
    });
  });
  it('participates in caller transactions for creation, replay and approval rollback', async () => {
    await fresh();
    await expect(
      handle.orm.em.fork().transactional(async (em) => {
        const transactional = new MikroOrmAgentStore(em, { clock: () => now });
        expect((await transactional.createActionProposal(proposal())).status).toBe('created');
        expect((await transactional.createActionProposal(proposal())).status).toBe('unchanged');
        expect((await transactional.getActionProposal(scope, 'proposal'))?.decision).toBe(
          'pending',
        );
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect(await peer.getActionProposal(scope, 'proposal')).toBeNull();
    await store.createActionProposal(proposal());
    await expect(
      handle.orm.em.fork().transactional(async (em) => {
        const transactional = new MikroOrmAgentStore(em, { clock: () => now });
        expect((await transactional.decideActionProposal(scope, 'proposal', approve)).status).toBe(
          'applied',
        );
        expect((await transactional.getActionProposal(scope, 'proposal'))?.execution?.status).toBe(
          'queued',
        );
        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');
    expect(await peer.getActionProposal(scope, 'proposal')).toMatchObject({
      decision: 'pending',
      execution: null,
    });
  });
  it.skipIf(dialect !== 'mysql')(
    'returns conflict when a repeatable-read transaction keeps a stale CAS snapshot',
    async () => {
      await fresh();
      await store.createActionProposal(proposal());
      const driver = handle.orm.em.getDriver();
      const original = driver.nativeUpdate.bind(driver);
      let attempts = 0;
      const spy = vi.spyOn(driver, 'nativeUpdate');
      let signalSnapshot = () => {};
      let releaseSnapshot = () => {};
      const snapshotReady = new Promise<void>((resolve) => {
        signalSnapshot = resolve;
      });
      const peerCommitted = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      try {
        const staleTransaction = handle.orm.em.fork().transactional(
          async (em) => {
            const transactional = new MikroOrmAgentStore(em, { clock: () => now });
            expect((await transactional.getActionProposal(scope, 'proposal'))?.decision).toBe(
              'pending',
            );
            signalSnapshot();
            await peerCommitted;
            spy.mockImplementation(async (...args) => {
              if (++attempts > 32) throw new Error('unbounded stale CAS retries');
              return original(...args);
            });
            expect(
              (await transactional.decideActionProposal(scope, 'proposal', approve)).status,
            ).toBe('conflict');
          },
          { isolationLevel: IsolationLevel.REPEATABLE_READ },
        );
        // Invoke the other connection outside MikroORM's ambient transaction context.
        await snapshotReady;
        expect((await peer.decideActionProposal(scope, 'proposal', approve)).status).toBe(
          'applied',
        );
        releaseSnapshot();
        await staleTransaction;
        expect(attempts).toBeLessThanOrEqual(32);
        expect(await peer.getActionProposal(scope, 'proposal')).toMatchObject({
          decision: 'approved',
          execution: { status: 'queued', generation: 0, lease: null },
        });
      } finally {
        releaseSnapshot();
        spy.mockRestore();
      }
    },
  );
  it('competes through independent connections for decision and fenced lease recovery', async () => {
    await fresh();
    await store.createActionProposal(proposal());
    const decisions = await Promise.all([
      store.decideActionProposal(scope, 'proposal', approve),
      peer.decideActionProposal(scope, 'proposal', { ...approve, decision: 'rejected' }),
    ]);
    expect(decisions.filter((result) => result.status === 'applied')).toHaveLength(1);
    const row = await store.getActionProposal(scope, 'proposal');
    expect(row?.decision).not.toBe('pending');
    if (row?.decision === 'rejected') {
      await store.createActionProposal(proposal('approved'));
      await peer.decideActionProposal(scope, 'approved', approve);
    }
    const id = row?.decision === 'approved' ? 'proposal' : 'approved';
    const claims = await Promise.all([
      store.claimActionProposal(scope, id, { workerId: 'a', leaseMs: 100 }),
      peer.claimActionProposal(scope, id, { workerId: 'b', leaseMs: 100 }),
    ]);
    expect(claims.filter((result) => result.status === 'applied')).toHaveLength(1);
    const original = (await peer.getActionProposal(scope, id))?.execution?.lease;
    expect(original).toBeTruthy();
    if (original === undefined || original === null) throw new Error('no lease');
    now = 1100;
    const recoveries = await Promise.all([
      store.claimActionProposal(scope, id, { workerId: 'recovery-a', leaseMs: 100 }),
      peer.claimActionProposal(scope, id, { workerId: 'recovery-b', leaseMs: 100 }),
    ]);
    const recovered = recoveries.find((result) => result.status === 'applied')?.proposal;
    expect(recoveries.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(recovered?.execution?.lease?.generation).toBe(original.generation + 1);
    expect(recovered?.idempotencyKey).toBe(`key:${id}`);
    expect(
      (
        await peer.settleActionProposal(scope, id, {
          ...original,
          status: 'succeeded',
          result: 'stale',
        })
      ).status,
    ).toBe('conflict');
  });
});
