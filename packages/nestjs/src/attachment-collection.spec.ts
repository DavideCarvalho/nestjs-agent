import type { AgentRunner, AgentStore, StagedAttachment } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryAttachmentStagingStore } from '@dudousxd/nestjs-agent-testing';
import { NotImplementedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentService } from './agent.service.js';

const runner: AgentRunner = {
  start: async () => ({ runId: 'run-1' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};

const deps = { defaultAgentName: () => 'default' } as unknown as AgentDepsFactory;

const ACTOR = { id: 'u1' };
const MONDAY = new Date('2026-03-02T00:00:00.000Z');
const FRIDAY = new Date('2026-03-06T00:00:00.000Z');

function buildService(store: AgentStore, staging?: InMemoryAttachmentStagingStore): AgentService {
  return new AgentService(runner, store, deps, undefined, staging);
}

async function stage(
  staging: InMemoryAttachmentStagingStore,
  filename: string,
  actorId = ACTOR.id,
): Promise<string> {
  const { mediaId } = await staging.stage({
    data: Buffer.from('bytes'),
    filename,
    contentType: 'image/png',
    sizeBytes: 5,
    actor: { id: actorId },
  });
  return mediaId;
}

/** Send `mediaId` on a message, the way a turn does once the user actually submits the composer. */
async function send(store: AgentStore, threadId: string, mediaId: string): Promise<string> {
  const message = await store.appendMessage({
    threadId,
    role: 'user',
    content: 'look at this',
    attachments: [
      { mediaId, url: 'https://media.test/x', contentType: 'image/png', name: 'a.png' },
    ],
  });
  return message.id;
}

function names(entries: StagedAttachment[]): string[] {
  return entries.map((entry) => entry.name).sort();
}

describe('AgentService — listing an actor’s staged attachments', () => {
  it('returns the actor’s own inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stage(staging, 'mine.png');
    await stage(staging, 'theirs.png', 'u2');

    const listed = await buildService(new InMemoryAgentStore(), staging).listAttachments(ACTOR);

    expect(names(listed)).toEqual(['mine.png']);
  });

  it('refuses rather than reporting an empty inventory when the store cannot list', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stage(staging, 'mine.png');
    Reflect.set(staging, 'list', undefined);

    await expect(
      buildService(new InMemoryAgentStore(), staging).listAttachments(ACTOR),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('refuses when no staging store is bound at all', async () => {
    await expect(
      buildService(new InMemoryAgentStore()).listAttachments(ACTOR),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });
});

describe('AgentService — what is safe to collect', () => {
  it('offers up media that was staged and never sent', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    await stage(staging, 'abandoned.png');

    const collectable = await buildService(
      new InMemoryAgentStore(),
      staging,
    ).collectableAttachments(ACTOR, { olderThan: FRIDAY });

    expect(names(collectable)).toEqual(['abandoned.png']);
  });

  it('keeps media a live message still carries', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const sent = await stage(staging, 'sent.png');
    await stage(staging, 'abandoned.png');
    await send(store, thread.id, sent);

    const collectable = await buildService(store, staging).collectableAttachments(ACTOR, {
      olderThan: FRIDAY,
    });

    expect(names(collectable)).toEqual(['abandoned.png']);
  });

  it('offers up media again once the message carrying it is truncated away', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const sent = await stage(staging, 'sent.png');
    const messageId = await send(store, thread.id, sent);
    const service = buildService(store, staging);
    expect(await service.collectableAttachments(ACTOR, { olderThan: FRIDAY })).toEqual([]);

    // exactly what regenerating a turn does
    await store.truncateFrom(thread.id, messageId);

    expect(names(await service.collectableAttachments(ACTOR, { olderThan: FRIDAY }))).toEqual([
      'sent.png',
    ]);
  });

  it('leaves an upload that has not been sent YET alone — in flight is not garbage', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    await stage(staging, 'old.png');
    staging.setClock(() => FRIDAY);
    await stage(staging, 'just-uploaded.png');

    const collectable = await buildService(
      new InMemoryAgentStore(),
      staging,
    ).collectableAttachments(ACTOR, { olderThan: new Date('2026-03-04T00:00:00.000Z') });

    expect(names(collectable)).toEqual(['old.png']);
  });

  it('applies the age cut itself, so a staging store that ignores stagedBefore cannot delete an in-flight upload', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => FRIDAY });
    await stage(staging, 'just-uploaded.png');
    const listAll = staging.list.bind(staging);
    Reflect.set(staging, 'list', (input: { actor: { id: string } }) =>
      listAll({ actor: input.actor }),
    );

    const collectable = await buildService(
      new InMemoryAgentStore(),
      staging,
    ).collectableAttachments(ACTOR, { olderThan: new Date('2026-03-04T00:00:00.000Z') });

    expect(collectable).toEqual([]);
  });

  it('pushes the age cut down to the staging store, so a sweep does not read the whole inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    await stage(staging, 'old.png');
    const list = vi.spyOn(staging, 'list');

    await buildService(new InMemoryAgentStore(), staging).collectableAttachments(ACTOR, {
      olderThan: FRIDAY,
    });

    expect(list.mock.calls[0]?.[0]?.stagedBefore).toBe(FRIDAY.toISOString());
  });

  it('refuses rather than declaring everything collectable when the store cannot answer references', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    const backing = new InMemoryAgentStore();
    const thread = await backing.createThread({ actor: ACTOR });
    const sent = await stage(staging, 'sent.png');
    await send(backing, thread.id, sent);
    // a store predating the reference query: everything else delegates, this one is simply absent
    const store = Object.create(backing) as AgentStore & { referencedMediaIds?: unknown };
    store.referencedMediaIds = undefined;

    await expect(
      buildService(store, staging).collectableAttachments(ACTOR, { olderThan: FRIDAY }),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('refuses when the staging store cannot list its inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore({ now: () => MONDAY });
    await stage(staging, 'abandoned.png');
    Reflect.set(staging, 'list', undefined);

    await expect(
      buildService(new InMemoryAgentStore(), staging).collectableAttachments(ACTOR, {
        olderThan: FRIDAY,
      }),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });
});
