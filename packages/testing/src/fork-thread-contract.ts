import type { ActionProposalOutcomeStore, AgentStore } from '@dudousxd/nestjs-agent-core';

/**
 * A store under test. `getThreadActionProposalScope` is how the contract reads a thread's tenant
 * back — every adapter in this repo offers it.
 */
export interface ForkThreadContractSubject {
  store: AgentStore & Pick<ActionProposalOutcomeStore, 'getThreadActionProposalScope'>;
}

/** One behaviour `AgentStore.forkThread` owes. `run` throws on a mismatch. */
export interface ForkThreadContractCase {
  name: string;
  run: (subject: ForkThreadContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const OWNER = { id: 'fork-owner', roles: [], tenantRef: 'tenant-1' };

/** A thread of OWNER's with two messages; returns it and the first message's id. */
async function seed(store: AgentStore): Promise<{ threadId: string; firstId: string }> {
  const thread = await store.createThread({ actor: OWNER });
  const first = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'one' });
  await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'two' });
  return { threadId: thread.id, firstId: first.id };
}

async function tenantOf(subject: ForkThreadContractSubject, threadId: string) {
  return (await subject.store.getThreadActionProposalScope(threadId))?.tenantRef ?? null;
}

/** `forkThread`'s options — "continue this conversation" from a shared link, and its tenant. */
export const FORK_THREAD_CONTRACT: ForkThreadContractCase[] = [
  {
    name: 'without options the copy is the source owner’s, in the source’s tenant',
    run: async (subject) => {
      const { store } = subject;
      const { threadId, firstId } = await seed(store);
      const fork = await store.forkThread(threadId, firstId);
      check((await store.ownerOfThread(fork.id)) === OWNER.id, 'the copy is the owner’s');
      check((await tenantOf(subject, fork.id)) === 'tenant-1', 'the copy keeps the tenant');
    },
  },
  {
    name: 'forks into another actor: the copy is theirs, the source stays its owner’s',
    run: async ({ store }) => {
      const { threadId, firstId } = await seed(store);
      const fork = await store.forkThread(threadId, firstId, { actorRef: 'fork-reader' });
      check((await store.ownerOfThread(fork.id)) === 'fork-reader', 'the copy is the reader’s');
      const copied = (await store.getThread(fork.id))?.messages.map((m) => m.content);
      check(JSON.stringify(copied) === '["one"]', 'the copy stops at the message', copied);
      const readers = (await store.listThreads('fork-reader')).map((t) => t.id);
      check(readers.includes(fork.id), 'the copy is in the reader’s list', readers);
      check(!readers.includes(threadId), 'the source is not in the reader’s list', readers);
      const owners = (await store.listThreads(OWNER.id)).map((t) => t.id);
      check(!owners.includes(fork.id), 'the copy is not in the owner’s list', owners);
      check(owners.includes(threadId), 'the source is still in the owner’s list', owners);
      check((await store.ownerOfThread(threadId)) === OWNER.id, 'the source is untouched');
      const source = (await store.getThread(threadId))?.messages.length;
      check(source === 2, 'the source keeps every message', source);
    },
  },
  {
    name: 'a new owner without a tenantRef keeps the source’s tenant',
    run: async (subject) => {
      const { threadId, firstId } = await seed(subject.store);
      const fork = await subject.store.forkThread(threadId, firstId, { actorRef: 'fork-reader' });
      const tenant = await tenantOf(subject, fork.id);
      check(tenant === 'tenant-1', 'absent keeps the source’s tenant', tenant);
    },
  },
  {
    name: 'tenantRef: null clears the copy’s tenant',
    run: async (subject) => {
      const { threadId, firstId } = await seed(subject.store);
      const fork = await subject.store.forkThread(threadId, firstId, {
        actorRef: 'fork-reader',
        tenantRef: null,
      });
      const tenant = await tenantOf(subject, fork.id);
      check(tenant === null, 'null clears the tenant', tenant);
      check((await tenantOf(subject, threadId)) === 'tenant-1', 'the source keeps its tenant');
    },
  },
  {
    name: 'a tenantRef sets the copy’s tenant',
    run: async (subject) => {
      const { threadId, firstId } = await seed(subject.store);
      const fork = await subject.store.forkThread(threadId, firstId, {
        actorRef: 'fork-reader',
        tenantRef: 'tenant-2',
      });
      const tenant = await tenantOf(subject, fork.id);
      check(tenant === 'tenant-2', 'a value sets the tenant', tenant);
    },
  },
];
