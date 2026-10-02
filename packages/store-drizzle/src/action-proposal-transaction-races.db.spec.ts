import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateActionProposal } from '@dudousxd/nestjs-agent-core';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AgentDrizzleDb } from './dialect.js';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

describeEachDialect('Drizzle independent transaction races', (dialect) => {
  let handle: AgentDbHandle;
  let directory: string;
  let source: DrizzleAgentStore;
  let peer: DrizzleAgentStore;
  const scope = { threadId: 'thread', actorRef: 'actor', tenantRef: 'tenant' };
  const input = (id: string): CreateActionProposal => ({
    ...scope,
    id,
    originRunId: id,
    originMessageId: 'message',
    originToolCallId: id,
    toolName: 'edit',
    input: { id },
    confirmation: { title: 'Edit?', verb: 'Edit' },
    approver: 'actor',
    expiresAt: null,
    idempotencyKey: id,
    replacementKey: 'document',
  });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'proposal-races-'));
    handle = await openAgentDb(dialect, { sqlitePath: join(directory, 'agent.sqlite') });
    source = new DrizzleAgentStore(handle.db, { clock: () => 1000 });
    peer = new DrizzleAgentStore(await handle.replica(), { clock: () => 1000 });
  });
  afterAll(async () => {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await handle.reset();
    await source.createThread({
      id: 'thread',
      actor: { id: 'actor', roles: [], tenantRef: 'tenant' },
    });
  });
  it('rolls back both the fact and admission marker with the caller transaction', async () => {
    await source.createActionProposal(input('proposal'));
    await source.decideActionProposal(scope, 'proposal', {
      decision: 'rejected',
      actorRef: 'actor',
      via: 'test',
    });
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    if (!claim) throw new Error('Expected outcome');
    const failure = new Error('caller rollback');
    if (dialect === 'sqlite') {
      const db = handle.db as unknown as { transaction<T>(callback: (tx: AgentDrizzleDb) => T): T };
      let operation: Promise<unknown> | undefined;
      expect(() =>
        db.transaction((tx) => {
          operation = new DrizzleAgentStore(tx, { clock: () => 1000 }).admitActionProposalOutcome(
            claim.lease,
          );
          throw failure;
        }),
      ).toThrow(failure);
      await operation;
    } else {
      const db = handle.db as unknown as {
        transaction<T>(callback: (tx: AgentDrizzleDb) => Promise<T>): Promise<T>;
      };
      await expect(
        db.transaction(async (tx) => {
          expect(
            (
              await new DrizzleAgentStore(tx, { clock: () => 1000 }).admitActionProposalOutcome(
                claim.lease,
              )
            ).status,
          ).toBe('applied');
          throw failure;
        }),
      ).rejects.toThrow(failure);
    }
    expect((await source.getThread('thread'))?.messages).toHaveLength(0);
    expect((await source.getActionProposal(scope, 'proposal'))?.outcomeDelivery?.status).toBe(
      'pending',
    );
    expect((await peer.admitActionProposalOutcome(claim.lease)).status).toBe('applied');
    expect((await source.getThread('thread'))?.messages).toHaveLength(1);
  });
  it('serializes approval against replacement without superseding an approved action', async () => {
    await source.createReplacingActionProposal(input('old'));
    const [approval, replacement] = await Promise.all([
      source.decideActionProposal(scope, 'old', {
        decision: 'approved',
        actorRef: 'actor',
        via: 'test',
      }),
      peer.createReplacingActionProposal(input('new')),
    ]);
    expect(replacement.status).toBe('created');
    const old = await source.getActionProposal(scope, 'old');
    expect(['approved', 'superseded']).toContain(old?.decision);
    if (old?.decision === 'approved') {
      expect(approval.status).toBe('applied');
      expect(old.execution?.status).toBe('queued');
      expect(old.supersededBy).toBeUndefined();
    } else {
      expect(approval.status).toBe('conflict');
      expect(old?.execution).toBeNull();
      expect(old?.supersededBy).toBe('new');
    }
    expect((await source.getActionProposal(scope, 'new'))?.decision).toBe('pending');
  });
  it('serializes a competing user claim with admission and preserves both results', async () => {
    await source.createActionProposal(input('proposal'));
    await source.decideActionProposal(scope, 'proposal', {
      decision: 'rejected',
      actorRef: 'actor',
      via: 'test',
    });
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    if (!claim) throw new Error('Expected outcome');
    const [userClaim, admission] = await Promise.all([
      source.claimActiveStream('thread', 'user-run'),
      peer.admitActionProposalOutcome(claim.lease),
    ]);
    expect(userClaim).toBe(true);
    expect(['busy', 'applied']).toContain(admission.status);
    expect((await source.getThread('thread'))?.messages).toHaveLength(
      admission.status === 'applied' ? 1 : 0,
    );
    await source.releaseActiveStream('thread', 'user-run');
    expect(['applied', 'unchanged']).toContain(
      (await peer.admitActionProposalOutcome(claim.lease)).status,
    );
    expect((await source.getThread('thread'))?.messages).toHaveLength(1);
  });
});
