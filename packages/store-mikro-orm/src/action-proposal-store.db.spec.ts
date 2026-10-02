import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionProposalStore, CreateActionProposal } from '@dudousxd/nestjs-agent-core';
import { ACTION_PROPOSAL_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { IsolationLevel } from '@mikro-orm/core';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { agentEntities } from './entities';
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
  let store: ActionProposalStore;
  let peer: ActionProposalStore;
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
