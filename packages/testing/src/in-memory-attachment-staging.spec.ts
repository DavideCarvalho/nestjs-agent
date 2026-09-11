import { describe, expect, it } from 'vitest';
import { InMemoryAttachmentStagingStore } from './in-memory-attachment-staging.js';

const PNG = { filename: 'a.png', contentType: 'image/png' };

function stagedAt(iso: string): InMemoryAttachmentStagingStore {
  return new InMemoryAttachmentStagingStore({ now: () => new Date(iso) });
}

describe('InMemoryAttachmentStagingStore', () => {
  it('resolves a staged id back to the attachment, for its owner only', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    const staged = await staging.stage({
      data: Buffer.from('bytes'),
      sizeBytes: 5,
      actor: { id: 'u1' },
      ...PNG,
    });

    expect(await staging.resolve({ mediaId: staged.mediaId, actor: { id: 'u1' } })).toMatchObject({
      mediaId: staged.mediaId,
      contentType: 'image/png',
      name: 'a.png',
    });
  });

  it('answers null identically for another actor’s id and for one that never existed', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    const staged = await staging.stage({
      data: Buffer.from('bytes'),
      sizeBytes: 5,
      actor: { id: 'u1' },
      ...PNG,
    });

    const notYours = await staging.resolve({ mediaId: staged.mediaId, actor: { id: 'u2' } });
    const neverExisted = await staging.resolve({ mediaId: 'imaginary', actor: { id: 'u2' } });

    expect(notYours).toBeNull();
    expect(neverExisted).toBeNull();
  });

  it('lists only the asking actor’s media, newest first, with the metadata a sweep needs', async () => {
    const staging = stagedAt('2026-01-01T00:00:00.000Z');
    await staging.stage({
      data: Buffer.from('aa'),
      sizeBytes: 2,
      actor: { id: 'u1' },
      filename: 'older.png',
      contentType: 'image/png',
    });
    const theirs = await staging.stage({
      data: Buffer.from('bb'),
      sizeBytes: 2,
      actor: { id: 'u2' },
      filename: 'theirs.png',
      contentType: 'image/png',
    });
    staging.setClock(() => new Date('2026-01-02T00:00:00.000Z'));
    await staging.stage({
      data: Buffer.from('ccc'),
      sizeBytes: 3,
      actor: { id: 'u1' },
      filename: 'newer.pdf',
      contentType: 'application/pdf',
    });

    const listed = await staging.list({ actor: { id: 'u1' } });

    expect(listed).toEqual([
      expect.objectContaining({
        name: 'newer.pdf',
        contentType: 'application/pdf',
        sizeBytes: 3,
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      expect.objectContaining({
        name: 'older.png',
        contentType: 'image/png',
        sizeBytes: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    expect(listed.map((entry) => entry.mediaId)).not.toContain(theirs.mediaId);
  });

  it('excludes media staged at or after stagedBefore, so an in-flight upload never shows up', async () => {
    const staging = stagedAt('2026-01-01T00:00:00.000Z');
    await staging.stage({
      data: Buffer.from('a'),
      sizeBytes: 1,
      actor: { id: 'u1' },
      filename: 'old.png',
      contentType: 'image/png',
    });
    staging.setClock(() => new Date('2026-01-05T00:00:00.000Z'));
    await staging.stage({
      data: Buffer.from('b'),
      sizeBytes: 1,
      actor: { id: 'u1' },
      filename: 'fresh.png',
      contentType: 'image/png',
    });

    const listed = await staging.list({
      actor: { id: 'u1' },
      stagedBefore: '2026-01-03T00:00:00.000Z',
    });

    expect(listed.map((entry) => entry.name)).toEqual(['old.png']);
  });

  it('caps the page at limit, keeping the newest', async () => {
    const staging = stagedAt('2026-01-01T00:00:00.000Z');
    for (const filename of ['one.png', 'two.png']) {
      await staging.stage({
        data: Buffer.from('a'),
        sizeBytes: 1,
        actor: { id: 'u1' },
        filename,
        contentType: 'image/png',
      });
      staging.setClock(() => new Date('2026-01-02T00:00:00.000Z'));
    }

    expect(await staging.list({ actor: { id: 'u1' }, limit: 1 })).toHaveLength(1);
  });

  it('forgets the bytes once the host collects them', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    const staged = await staging.stage({
      data: Buffer.from('bytes'),
      sizeBytes: 5,
      actor: { id: 'u1' },
      ...PNG,
    });

    await staging.delete(staged.mediaId);

    expect(await staging.list({ actor: { id: 'u1' } })).toEqual([]);
    expect(await staging.resolve({ mediaId: staged.mediaId, actor: { id: 'u1' } })).toBeNull();
  });
});
