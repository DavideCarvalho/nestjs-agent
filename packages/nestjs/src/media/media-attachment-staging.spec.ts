import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { ResumableUploadManager, StorageManager } from '@dudousxd/nestjs-media-core';
import {
  InMemoryDriver,
  InMemoryMediaStore,
  InMemoryUploadSessionStore,
} from '@dudousxd/nestjs-media-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaAttachmentStaging } from './media-attachment-staging.js';
import type { AgentMediaAttachmentsOptions } from './media-attachments.options.js';

const ALICE: Actor = { id: 'alice' };
const BOB: Actor = { id: 'bob' };

/** A presign-capable disk, so the private-url path is observable without S3. */
class PresignDriver extends InMemoryDriver {
  override readonly capabilities = { ...new InMemoryDriver().capabilities, presign: true };
  override async temporaryUrl(path: string, expiresInSeconds: number): Promise<string> {
    return `https://signed.test/${path}?ttl=${expiresInSeconds}`;
  }
}

function setup(options: AgentMediaAttachmentsOptions = {}, driver = new InMemoryDriver()) {
  const storage = new StorageManager({ default: 'mem', disks: { mem: driver } });
  const store = new InMemoryMediaStore();
  const sessions = new InMemoryUploadSessionStore();
  const uploads = new ResumableUploadManager({ storage, sessions, emitDiagnostics: false });
  const agentStore = new InMemoryAgentStore();
  const staging = new MediaAttachmentStaging({ storage, store, uploads, agentStore }, options);
  return { storage, store, uploads, sessions, agentStore, staging, driver };
}

/** What the tus PATCH route does with the bytes: write at offset 0, completing the session. */
async function pushBytes(uploads: ResumableUploadManager, uploadId: string, bytes: Buffer) {
  await uploads.writeChunk(uploadId, 0, bytes);
  await uploads.complete(uploadId);
}

const PNG = Buffer.from('fake-png-bytes');

describe('MediaAttachmentStaging — resumable (tus) uploads', () => {
  it('opens a tus session owned by the actor and resolves once the bytes land', async () => {
    const { staging, uploads } = setup();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    expect(begun.location).toBe(`/media/uploads/${begun.uploadId}`);

    // Not sendable before the bytes are there.
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: ALICE })).toBeNull();

    await pushBytes(uploads, begun.uploadId, PNG);
    const completed = await staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId });
    expect(completed).toMatchObject({
      mediaId: begun.mediaId,
      contentType: 'image/png',
      name: 'cat.png',
    });

    const resolved = await staging.resolve({ mediaId: begun.mediaId, actor: ALICE });
    // In-memory disk: no presign, no public url → the bytes ride inline.
    expect(resolved?.url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('resolve verifies a pending upload itself, so skipping complete() still works', async () => {
    const { staging, uploads } = setup();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'a.pdf',
      contentType: 'application/pdf',
      size: PNG.byteLength,
    });
    await pushBytes(uploads, begun.uploadId, PNG);
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: ALICE })).toMatchObject({
      mediaId: begun.mediaId,
      contentType: 'application/pdf',
    });
  });

  it('never resolves or completes another actor’s media, indistinguishably from unknown ids', async () => {
    const { staging, uploads } = setup();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    await pushBytes(uploads, begun.uploadId, PNG);
    expect(await staging.completeUpload({ actor: BOB, mediaId: begun.mediaId })).toBeNull();
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: BOB })).toBeNull();
    expect(await staging.resolve({ mediaId: 'nope', actor: BOB })).toBeNull();
    expect(await staging.discard({ actor: BOB, mediaId: begun.mediaId })).toBe(false);
  });

  it('resolves media another actor staged when it rides a message in the caller’s own thread', async () => {
    const { staging, uploads, agentStore } = setup();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    await pushBytes(uploads, begun.uploadId, PNG);
    const attachment = await staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId });
    const thread = await agentStore.createThread({ actor: BOB });
    await agentStore.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [attachment as NonNullable<typeof attachment>],
    });
    expect(await staging.resolve({ mediaId: begun.mediaId, actor: BOB })).not.toBeNull();
  });

  it('refuses content types and sizes outside the policy before any session opens', async () => {
    const { staging, sessions } = setup({ maxBytes: 10, allowedContentTypes: ['image/png'] });
    await expect(
      staging.beginUpload({ actor: ALICE, filename: 'x.exe', contentType: 'app/x', size: 1 }),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      staging.beginUpload({
        actor: ALICE,
        filename: 'big.png',
        contentType: 'image/png',
        size: 11,
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      staging.beginUpload({ actor: ALICE, filename: '', contentType: 'image/png', size: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await sessions.list()).toEqual([]);
  });

  it('rejects completion while bytes are missing, and drops an upload whose size lies', async () => {
    const { staging, uploads, store } = setup();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    await expect(
      staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId }),
    ).rejects.toMatchObject({ status: 409 });

    // One oversized chunk: the session completes, but not with the size that was declared.
    await uploads.writeChunk(begun.uploadId, 0, Buffer.concat([PNG, PNG]));
    await uploads.complete(begun.uploadId);
    await expect(
      staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await store.find(begun.mediaId)).toBeNull();
  });

  it('discard aborts the in-flight session and removes the record', async () => {
    const { staging, sessions, store } = setup();
    const begun = await staging.beginUpload({
      actor: ALICE,
      filename: 'cat.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    expect(await staging.discard({ actor: ALICE, mediaId: begun.mediaId })).toBe(true);
    expect(await sessions.get(begun.uploadId)).toBeNull();
    expect(await store.find(begun.mediaId)).toBeNull();
  });

  it('refuses to open a session when resumable uploads are not configured', async () => {
    const storage = new StorageManager({ default: 'mem', disks: { mem: new InMemoryDriver() } });
    const staging = new MediaAttachmentStaging(
      { storage, store: new InMemoryMediaStore(), uploads: null },
      {},
    );
    await expect(
      staging.beginUpload({ actor: ALICE, filename: 'a.png', contentType: 'image/png', size: 1 }),
    ).rejects.toMatchObject({ status: 501 });
  });
});

describe('MediaAttachmentStaging — stage (POST /agent/attachments)', () => {
  it('stores the bytes as a ready media record the actor owns', async () => {
    const { staging, driver, store } = setup();
    const attachment = await staging.stage({
      data: PNG,
      filename: '../../etc/cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    const record = await store.find(attachment.mediaId);
    expect(record).toMatchObject({
      ownerType: 'agent-actor',
      ownerId: 'alice',
      collection: 'agent-attachments',
      mimeType: 'image/png',
      size: PNG.byteLength,
    });
    expect(record?.path).not.toContain('..');
    expect(await driver.get(record?.path ?? '')).toEqual(PNG);
    expect(await staging.resolve({ mediaId: attachment.mediaId, actor: ALICE })).not.toBeNull();
  });
});

describe('MediaAttachmentStaging — urls', () => {
  it('private + presign-capable disk → a temporary url with the configured ttl', async () => {
    const { staging } = setup({ urlExpiresInSeconds: 60 }, new PresignDriver());
    const { mediaId } = await staging.stage({
      data: PNG,
      filename: 'cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    const resolved = await staging.resolve({ mediaId, actor: ALICE });
    expect(resolved?.url).toMatch(/^https:\/\/signed\.test\/.+\?ttl=60$/);
  });

  it('a host resolveUrl wins over every built-in strategy', async () => {
    const { staging } = setup({ resolveUrl: (record) => `https://proxy.test/${record.id}` });
    const { mediaId } = await staging.stage({
      data: PNG,
      filename: 'cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    expect((await staging.resolve({ mediaId, actor: ALICE }))?.url).toBe(
      `https://proxy.test/${mediaId}`,
    );
  });

  it('does not echo inline bytes back to the uploader', async () => {
    const { staging } = setup();
    const attachment = await staging.stage({
      data: PNG,
      filename: 'cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    expect(attachment.url).toBe('');
  });
});

describe('MediaAttachmentStaging — inventory + cleanup', () => {
  it('lists only the actor’s own media, newest first, honouring stagedBefore and limit', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { staging } = setup({ clock: () => now });
    const stage = (actor: Actor, filename: string) =>
      staging.stage({
        data: PNG,
        filename,
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
        actor,
      });
    await stage(ALICE, 'old.png');
    now = new Date('2026-01-02T00:00:00Z');
    await stage(ALICE, 'new.png');
    await stage(BOB, 'bob.png');

    expect((await staging.list({ actor: ALICE })).map((entry) => entry.name)).toEqual([
      'new.png',
      'old.png',
    ]);
    expect(
      (await staging.list({ actor: ALICE, stagedBefore: '2026-01-01T12:00:00.000Z' })).map(
        (entry) => entry.name,
      ),
    ).toEqual(['old.png']);
    expect(await staging.list({ actor: ALICE, limit: 1 })).toHaveLength(1);
    expect((await staging.list({ actor: ALICE }))[0]).toMatchObject({
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('remove deletes the bytes and the record', async () => {
    const { staging, driver, store } = setup();
    const { mediaId } = await staging.stage({
      data: PNG,
      filename: 'cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    const path = (await store.find(mediaId))?.path ?? '';
    await staging.remove(mediaId);
    expect(await driver.exists(path)).toBe(false);
    expect(await store.find(mediaId)).toBeNull();
  });
});

describe('MediaAttachmentStaging — RAG announcement', () => {
  const seen: unknown[] = [];
  const onAttach = (message: unknown) => seen.push(message);
  afterEach(() => {
    unsubscribe('aviary:media:attach', onAttach);
    seen.length = 0;
  });

  it('announces ready media on aviary:media:attach only when indexForRag is set', async () => {
    subscribe('aviary:media:attach', onAttach);
    const quiet = setup();
    await quiet.staging.stage({
      data: PNG,
      filename: 'a.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    expect(seen).toHaveLength(0);

    const loud = setup({ indexForRag: true });
    const begun = await loud.staging.beginUpload({
      actor: ALICE,
      filename: 'b.pdf',
      contentType: 'application/pdf',
      size: PNG.byteLength,
    });
    await pushBytes(loud.uploads, begun.uploadId, PNG);
    await loud.staging.completeUpload({ actor: ALICE, mediaId: begun.mediaId });
    // complete + a later resolve must not announce the same record twice.
    await loud.staging.resolve({ mediaId: begun.mediaId, actor: ALICE });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      payload: {
        id: begun.mediaId,
        ownerType: 'agent-actor',
        ownerId: 'alice',
        collection: 'agent-attachments',
        mimeType: 'application/pdf',
      },
    });
  });
});

describe('MediaAttachmentStaging — custom access rule', () => {
  it('canAccess replaces the default owner check (e.g. a shared team space)', async () => {
    const { staging } = setup({
      canAccess: ({ record, actor }) => record.ownerId === actor.id || actor.tenantRef === 'team',
    });
    const { mediaId } = await staging.stage({
      data: PNG,
      filename: 'cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    expect(
      await staging.resolve({ mediaId, actor: { id: 'carol', tenantRef: 'team' } }),
    ).not.toBeNull();
    expect(await staging.resolve({ mediaId, actor: BOB })).toBeNull();
  });

  it('canAccess is handed the default verdict so it can extend rather than rewrite it', async () => {
    const { staging } = setup({ canAccess: ({ allowed }) => allowed });
    const { mediaId } = await staging.stage({
      data: PNG,
      filename: 'cat.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      actor: ALICE,
    });
    expect(await staging.resolve({ mediaId, actor: ALICE })).not.toBeNull();
    expect(await staging.resolve({ mediaId, actor: BOB })).toBeNull();
  });
});
