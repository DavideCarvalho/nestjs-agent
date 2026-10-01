import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transitionActionProposalClaim } from '@dudousxd/nestjs-agent-core';
import type {
  ActionProposalScope,
  CreateActionProposal,
  ListActionProposals,
} from '@dudousxd/nestjs-agent-core';
import {
  ACTION_PROPOSAL_STORE_CONTRACT,
  ACTION_PROPOSAL_WORKER_STORE_CONTRACT,
} from '@dudousxd/nestjs-agent-testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { type AgentDrizzleDb, type AgentMySqlDb, asBuilder } from './dialect.js';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import {
  type AgentDbHandle,
  columnsOf,
  describeEachDialect,
  openAgentDb,
} from './testing/real-db.js';

describeEachDialect('Drizzle action proposal persistence', (dialect) => {
  let handle: AgentDbHandle;
  let directory: string | undefined;
  const queries: string[] = [];
  let intercept: ((query: string) => void) | undefined;
  beforeAll(async () => {
    if (dialect === 'sqlite') directory = await mkdtemp(join(tmpdir(), 'agent-proposal-'));
    handle = await openAgentDb(dialect, {
      ...(directory === undefined ? {} : { sqlitePath: join(directory, 'proposals.db') }),
      logger: {
        logQuery: (query) => {
          queries.push(query);
          intercept?.(query);
        },
      },
    });
  });
  afterAll(async () => {
    await handle?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await handle.run('delete from agent_action_proposal');
  });

  const scope: ActionProposalScope = {
    tenantRef: null,
    actorRef: 'actor',
    threadId: 'unpersisted-thread',
  };
  const input = (id = 'proposal'): CreateActionProposal => ({
    ...scope,
    id,
    originRunId: 'run',
    originMessageId: 'message',
    originToolCallId: 'call',
    toolName: 'refund',
    input: { amount: 12 },
    confirmation: { title: 'Refund?', verb: 'Refund' },
    approver: 'actor',
    expiresAt: 2000,
    idempotencyKey: 'stable-key',
  });

  for (const contract of ACTION_PROPOSAL_STORE_CONTRACT) {
    it(contract.name, async () => {
      let now = 1000;
      await contract.run({
        store: new DrizzleAgentStore(handle.db, { clock: () => now }),
        setNow: (value) => {
          now = value;
        },
      });
    });
  }

  for (const contract of ACTION_PROPOSAL_WORKER_STORE_CONTRACT) {
    it(contract.name, async () => {
      let now = 1000;
      await contract.run({
        store: new DrizzleAgentStore(handle.db, { clock: () => now }),
        setNow: (value) => {
          now = value;
        },
      });
    });
  }

  it('discovers queued actions on the actual store and expires pending actions', async () => {
    let now = 1000;
    const store = new DrizzleAgentStore(handle.db, { clock: () => now });
    await store.createActionProposal(input('queued'));
    await store.createActionProposal(input('pending'));
    await store.decideActionProposal(scope, 'queued', {
      decision: 'approved',
      actorRef: 'actor',
      via: 'test',
    });
    const claimed = await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 });
    expect(claimed?.id).toBe('queued');
    expect(claimed?.execution?.lease?.generation).toBe(1);
    expect(await store.claimNextActionProposal({ workerId: 'peer', leaseMs: 100 })).toBeNull();
    now = 2000;
    expect(await store.expireActionProposals({ limit: 1 })).toBe(1);
    expect((await store.getActionProposal(scope, 'pending'))?.decision).toBe('expired');
  });

  it('backfills legacy discovery metadata with bounded fenced writes', async () => {
    let now = 1000;
    const store = new DrizzleAgentStore(handle.db, { clock: () => now });
    for (const id of ['legacy-a', 'legacy-b']) {
      await store.createActionProposal(input(id));
      await store.decideActionProposal(scope, id, {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      });
    }
    await handle.run(
      'update agent_action_proposal set discovery_index_version = 0, execution_status = null, lease_expires_at = null, proposal_expires_at = null',
    );
    expect(await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 })).toBeNull();
    const before = await store.getActionProposal(scope, 'legacy-a');
    queries.length = 0;
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(1);
    expect(queries.filter((query) => /^select/i.test(query))).toHaveLength(1);
    expect(queries[0]).toMatch(/limit/i);
    expect(await store.getActionProposal(scope, 'legacy-a')).toEqual(before);
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(1);
    expect(await store.backfillActionProposalDiscoveryIndex({ limit: 1 })).toBe(0);
    const claim = await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 });
    expect(claim?.id).toBe('legacy-a');
    now = 1100;
    const recovered = await store.claimNextActionProposal({ workerId: 'peer', leaseMs: 100 });
    expect(recovered?.execution?.lease?.generation).toBe(2);
    expect(recovered?.execution?.lease?.token).not.toBe(claim?.execution?.lease?.token);
  });

  it('wins discovery races across pools and retains exact Unicode scopes and fences', async () => {
    let now = 1000;
    const store = new DrizzleAgentStore(handle.db, { clock: () => now });
    const peer = new DrizzleAgentStore(await handle.replica(), { clock: () => now });
    const unusual = { tenantRef: '\u0000\ud800', actorRef: 'actor ', threadId: '\ud800' };
    await store.createActionProposal({ ...input('\ud800'), ...unusual });
    await store.decideActionProposal(unusual, '\ud800', {
      decision: 'approved',
      actorRef: 'actor ',
      via: 'test',
    });
    const claims = await Promise.all([
      store.claimNextActionProposal({ workerId: 'one', leaseMs: 100 }),
      peer.claimNextActionProposal({ workerId: 'two', leaseMs: 100 }),
    ]);
    const won = claims.filter((claim) => claim !== null);
    expect(won).toHaveLength(1);
    expect(won[0]?.tenantRef).toBe(unusual.tenantRef);
    now = 1100;
    const recovered = await peer.claimNextActionProposal({ workerId: 'recovery', leaseMs: 100 });
    expect(recovered?.execution?.lease?.generation).toBe(2);
    const oldLease = won[0]?.execution?.lease;
    if (!oldLease) throw new Error('expected won fence');
    expect(
      (
        await store.settleActionProposal(unusual, '\ud800', {
          token: oldLease.token,
          generation: oldLease.generation,
          status: 'succeeded',
        })
      ).status,
    ).toBe('conflict');
    const lease = recovered?.execution?.lease;
    if (!lease) throw new Error('expected recovery fence');
    expect(
      (
        await peer.settleActionProposal(unusual, '\ud800', {
          token: lease.token,
          generation: lease.generation,
          status: 'succeeded',
        })
      ).status,
    ).toBe('applied');
    expect(await store.claimNextActionProposal({ workerId: 'three', leaseMs: 100 })).toBeNull();
  });

  it('bounds discovery SQL and validates commands even when no candidates exist', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    await expect(store.claimNextActionProposal({ workerId: '', leaseMs: 100 })).rejects.toThrow();
    await expect(store.expireActionProposals({ limit: 0 })).rejects.toThrow();
    await expect(store.backfillActionProposalDiscoveryIndex({ limit: 0 })).rejects.toThrow();
    for (const id of ['z', 'ä', 'Ω', '😀', '\uE000']) {
      await store.createActionProposal(input(id));
      await store.decideActionProposal(scope, id, {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      });
    }
    queries.length = 0;
    expect((await store.claimNextActionProposal({ workerId: 'worker', leaseMs: 100 }))?.id).toBe(
      'z',
    );
    expect(queries[0]).toMatch(/execution_status/);
    expect(queries[0]).toMatch(/limit/i);
    expect(queries[0]).toMatch(/logical_sort/);
    await store.createActionProposal(input('due'));
    const later = new DrizzleAgentStore(handle.db, { clock: () => 2000 });
    queries.length = 0;
    expect(await later.expireActionProposals({ limit: 1 })).toBe(1);
    expect(queries[0]).toMatch(/proposal_expires_at/);
    expect(queries[0]).toMatch(/limit/i);
    const expired = await later.getActionProposal(scope, 'due');
    expect(expired?.decisionAudit?.actorRef).toBe('system');
    expect(expired?.decisionAudit?.via).toBe('expiry');
  });

  it('upgrades a legacy table and backfills competing batches without changing its snapshot', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    const peer = new DrizzleAgentStore(await handle.replica(), { clock: () => 1000 });
    await store.createActionProposal(input('upgrade'));
    await store.decideActionProposal(scope, 'upgrade', {
      decision: 'approved',
      actorRef: 'actor',
      via: 'test',
    });
    const before = await store.getActionProposal(scope, 'upgrade');
    for (const index of [
      'agent_action_proposal_execution_idx',
      'agent_action_proposal_expiry_idx',
    ]) {
      await handle.run(
        dialect === 'mysql'
          ? `drop index ${index} on agent_action_proposal`
          : `drop index ${index}`,
      );
    }
    for (const column of [
      'execution_status',
      'lease_expires_at',
      'proposal_expires_at',
      'discovery_index_version',
    ]) {
      await handle.run(`alter table agent_action_proposal drop column ${column}`);
    }
    await ensureAgentSchema(handle.db);
    expect(
      await store.claimNextActionProposal({ workerId: 'before-backfill', leaseMs: 100 }),
    ).toBeNull();
    const changed = await Promise.all([
      store.backfillActionProposalDiscoveryIndex({ limit: 1 }),
      peer.backfillActionProposalDiscoveryIndex({ limit: 1 }),
    ]);
    expect(changed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await store.getActionProposal(scope, 'upgrade')).toEqual(before);
    expect(
      (await store.claimNextActionProposal({ workerId: 'after-backfill', leaseMs: 100 }))?.id,
    ).toBe('upgrade');
  });

  it('preserves arbitrary JSON strings and exact surrogate ID identity', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    for (const id of ['\ud800', '\ufffd', 'null-character']) {
      expect(
        (
          await store.createActionProposal({
            ...input(id),
            input: { value: '\u0000', loneSurrogate: '\ud800' },
          })
        ).status,
      ).toBe('created');
      expect((await store.getActionProposal(scope, id))?.input).toEqual({
        value: '\u0000',
        loneSurrogate: '\ud800',
      });
    }
    expect(await store.listActionProposals(scope)).toHaveLength(3);
  });

  it('bounds filtered SQL reads and sorts logical IDs by UTF16 code units', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    for (const id of ['z', 'a', '\u{10000}', '\ue000']) await store.createActionProposal(input(id));
    await store.decideActionProposal(scope, 'a', {
      decision: 'rejected',
      actorRef: 'actor',
      via: 'test',
    });
    queries.length = 0;
    expect(
      (await store.listActionProposals(scope, { decision: 'pending', limit: 2 })).map(
        (row) => row.id,
      ),
    ).toEqual(['z', '\u{10000}']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/limit/i);
  });

  if (dialect === 'mysql') {
    it('bounds lost CAS retries inside a caller repeatable-read snapshot', async () => {
      const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
      const peer = new DrizzleAgentStore(await handle.replica(), { clock: () => 1000 });
      await store.createActionProposal(input());
      await store.decideActionProposal(scope, 'proposal', {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      });
      await (handle.db as AgentMySqlDb).transaction(
        async (transaction) => {
          const caller = new DrizzleAgentStore(transaction as unknown as AgentDrizzleDb, {
            clock: () => 1000,
          });
          expect((await caller.getActionProposal(scope, 'proposal'))?.execution?.status).toBe(
            'queued',
          );
          expect(
            (await peer.claimActionProposal(scope, 'proposal', { workerId: 'peer', leaseMs: 100 }))
              .status,
          ).toBe('applied');
          let attempts = 0;
          intercept = (query) => {
            if (/^update .*agent_action_proposal/.test(query) && ++attempts > 32) {
              throw new Error('CAS retries exceeded the bounded retry budget');
            }
          };
          try {
            const result = await caller.claimActionProposal(scope, 'proposal', {
              workerId: 'caller',
              leaseMs: 100,
            });
            expect(result.status).toBe('conflict');
            expect(attempts).toBe(32);
          } finally {
            intercept = undefined;
          }
        },
        { isolationLevel: 'repeatable read' },
      );
      expect((await store.getActionProposal(scope, 'proposal'))?.execution?.lease?.workerId).toBe(
        'peer',
      );
    });
  }

  if (dialect === 'sqlite') {
    it('returns the winning claim snapshot even if a peer immediately recovers its lease', async () => {
      let now = 1000;
      const store = new DrizzleAgentStore(handle.db, { clock: () => now });
      await store.createActionProposal(input());
      await store.decideActionProposal(scope, 'proposal', {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      });
      const replica = asBuilder(await handle.replica());
      let wrote = false;
      intercept = (query) => {
        if (/^update .*agent_action_proposal/.test(query)) wrote = true;
        if (wrote && /^select .*agent_action_proposal/.test(query)) {
          intercept = undefined;
          now = 1001;
          const table = handle.t.agentActionProposal;
          const row = replica.select().from(table).get();
          if (!row || row instanceof Promise)
            throw new Error('expected synchronous SQLite proposal');
          const recovered = transitionActionProposalClaim(
            row.proposal,
            { workerId: 'peer', leaseMs: 10 },
            now,
            'peer-token',
          );
          if (!recovered.proposal) throw new Error('missing recovered proposal');
          replica
            .update(table)
            .set({ proposal: recovered.proposal, version: row.version + 1 })
            .where(eq(table.id, row.id))
            .run();
        }
      };
      try {
        const claimed = await store.claimActionProposal(scope, 'proposal', {
          workerId: 'original',
          leaseMs: 1,
        });
        expect(claimed.status).toBe('applied');
        expect(claimed.proposal?.execution?.lease?.workerId).toBe('original');
        expect(claimed.proposal?.execution?.generation).toBe(1);
        expect((await store.getActionProposal(scope, 'proposal'))?.execution?.lease?.workerId).toBe(
          'peer',
        );
      } finally {
        intercept = undefined;
      }
    });
  }

  it('rejects unsupported runtime list decisions', async () => {
    const store = new DrizzleAgentStore(handle.db);
    for (const decision of ['', null, 'unsupported']) {
      await expect(
        store.listActionProposals(scope, { decision } as unknown as ListActionProposals),
      ).rejects.toThrow(TypeError);
    }
  });

  it('rejects invalid list bounds consistently with the core adapter', async () => {
    const store = new DrizzleAgentStore(handle.db);
    for (const limit of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.listActionProposals(scope, { limit })).rejects.toThrow(RangeError);
    }
  });

  it('keeps approval and execution absent when the single atomic update fails', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    await store.createActionProposal(input());
    if (dialect === 'postgres') {
      await handle.run(
        "create function fail_proposal_update() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$",
      );
      await handle.run(
        'create trigger reject_proposal_update before update on agent_action_proposal for each row execute function fail_proposal_update()',
      );
    } else if (dialect === 'mysql') {
      await handle.run(
        "create trigger reject_proposal_update before update on agent_action_proposal for each row signal sqlstate '45000' set message_text = 'injected failure'",
      );
    } else {
      await handle.run(
        "create trigger reject_proposal_update before update on agent_action_proposal begin select raise(abort, 'injected failure'); end",
      );
    }
    try {
      await expect(
        store.decideActionProposal(scope, 'proposal', {
          decision: 'approved',
          actorRef: 'actor',
          via: 'test',
        }),
      ).rejects.toThrow();
      expect(await store.getActionProposal(scope, 'proposal')).toMatchObject({
        decision: 'pending',
        decisionAudit: null,
        execution: null,
      });
    } finally {
      await handle.run(
        dialect === 'postgres'
          ? 'drop trigger reject_proposal_update on agent_action_proposal'
          : 'drop trigger reject_proposal_update',
      );
      if (dialect === 'postgres') await handle.run('drop function fail_proposal_update()');
    }
  });

  it('makes concurrent replay first-wins across independent connections', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    const replica = new DrizzleAgentStore(await handle.replica(), { clock: () => 1000 });
    const results = await Promise.all([
      store.createActionProposal(input()),
      replica.createActionProposal(input()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['created', 'unchanged']);
    expect(await store.listActionProposals(scope)).toHaveLength(1);
  });

  it('preserves exact trailing-space identity for IDs and scopes', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    expect((await store.createActionProposal(input('proposal'))).status).toBe('created');
    expect((await store.createActionProposal(input('proposal '))).status).toBe('created');
    expect((await store.getActionProposal(scope, 'proposal '))?.id).toBe('proposal ');
    expect(await store.getActionProposal({ ...scope, actorRef: 'actor ' }, 'proposal')).toBeNull();
    expect(await store.listActionProposals({ ...scope, threadId: 'unpersisted-thread ' })).toEqual(
      [],
    );
  });

  it('creates and replays an immutable snapshot scoped independently of a thread', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    expect((await store.createActionProposal(input())).status).toBe('created');
    expect((await store.createActionProposal(input())).status).toBe('unchanged');
    expect((await store.createActionProposal({ ...input(), input: { amount: 99 } })).status).toBe(
      'conflict',
    );
    expect(await store.getActionProposal({ ...scope, actorRef: 'other' }, 'proposal')).toBeNull();
    expect(await store.listActionProposals(scope)).toHaveLength(1);
  });

  it('fences approval, crash recovery, and settlement across replicas', async () => {
    let now = 1000;
    const store = new DrizzleAgentStore(handle.db, { clock: () => now });
    const replica = new DrizzleAgentStore(await handle.replica(), { clock: () => now });
    await store.createActionProposal(input());
    const decisions = await Promise.all([
      store.decideActionProposal(scope, 'proposal', {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      }),
      replica.decideActionProposal(scope, 'proposal', {
        decision: 'rejected',
        actorRef: 'actor',
        via: 'test',
      }),
    ]);
    expect(decisions.map((r) => r.status).sort()).toEqual(['applied', 'conflict']);
    if ((await store.getActionProposal(scope, 'proposal'))?.decision !== 'approved') {
      await store.createActionProposal(input('approved'));
      await store.decideActionProposal(scope, 'approved', {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      });
    }
    const proposalId =
      (await store.getActionProposal(scope, 'proposal'))?.decision === 'approved'
        ? 'proposal'
        : 'approved';
    const claims = await Promise.all([
      store.claimActionProposal(scope, proposalId, { workerId: 'a', leaseMs: 10 }),
      replica.claimActionProposal(scope, proposalId, { workerId: 'b', leaseMs: 10 }),
    ]);
    expect(claims.filter((r) => r.status === 'applied')).toHaveLength(1);
    const first = claims.find((r) => r.status === 'applied')?.proposal?.execution?.lease;
    expect(first).toBeTruthy();
    if (!first) throw new Error('missing lease');
    now = first.expiresAt;
    expect(
      (
        await store.settleActionProposal(scope, proposalId, {
          token: first.token,
          generation: first.generation,
          status: 'succeeded',
        })
      ).status,
    ).toBe('expired');
    const recovered = await replica.claimActionProposal(scope, proposalId, {
      workerId: 'c',
      leaseMs: 10,
    });
    const lease = recovered.proposal?.execution?.lease;
    expect(lease?.generation).toBe(first.generation + 1);
    expect(recovered.proposal?.idempotencyKey).toBe('stable-key');
    expect(
      (
        await store.extendActionProposalLease(scope, proposalId, {
          token: first.token,
          generation: first.generation,
          leaseMs: 10,
        })
      ).status,
    ).toBe('conflict');
    if (!lease) throw new Error('missing recovered lease');
    expect(
      (
        await store.settleActionProposal(scope, proposalId, {
          token: lease.token,
          generation: lease.generation,
          status: 'succeeded',
          result: { ok: true },
        })
      ).status,
    ).toBe('applied');
  });

  it('expires at the trusted clock boundary', async () => {
    const store = new DrizzleAgentStore(handle.db, { clock: () => 2000 });
    await store.createActionProposal(input());
    const result = await store.decideActionProposal(scope, 'proposal', {
      decision: 'approved',
      actorRef: 'actor',
      via: 'test',
    });
    expect(result.status).toBe('expired');
    expect(result.proposal?.decision).toBe('expired');
    expect(result.proposal?.execution).toBeNull();
  });

  it('provisions an independent proposal table additively', async () => {
    expect(await columnsOf(handle, 'agent_action_proposal')).toContain('proposal');
    expect(await handle.rows('select * from agent_thread')).toEqual([]);
  });
});
