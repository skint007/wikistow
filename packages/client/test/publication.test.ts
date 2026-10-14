import { describe, expect, it } from 'vite-plus/test';
import { anyKeyDecrypts, anyKeyOpensBlob, keysIn, stealableKeys } from './support/testing.ts';
import { buildWorld } from './fixture/world.ts';

describe('a reader holding every stored ciphertext and their own keys', () => {
  const world = buildWorld();
  const { server, reader, page, revisions } = world;
  const stored = (id: typeof revisions.firstDraft) => {
    const revision = server.revisions.get(id);
    if (!revision) throw new Error(`missing ${id}`);
    return revision;
  };

  it('cannot decrypt either draft or its attachment with any key it can find', () => {
    const envelopeKeys = stealableKeys(server.envelopes, reader.identity);
    expect(envelopeKeys).toHaveLength(1); // only the publication's envelope opens
    const { opened } = reader.read(page, revisions.publication);
    if (opened.kind !== 'current') throw new Error('expected current format');
    // Its own envelope keys, plus anything key-shaped inside what it can read.
    const found = [...envelopeKeys, ...keysIn(opened.payload)];

    expect(anyKeyDecrypts(found, stored(revisions.publication))).toBe(true);
    expect(anyKeyDecrypts(found, stored(revisions.firstDraft))).toBe(false);
    expect(anyKeyDecrypts(found, stored(revisions.privateDraft))).toBe(false);

    const ids = opened.payload.attachments.map((ref) => ref.id);
    const at = (audience: 'draft' | 'published') => ({
      installationId: server.installationId,
      spaceId: world.spaceId,
      pageId: page,
      audience,
    });
    const blobs = (audience: 'draft' | 'published') =>
      [...server.blobs.values()].filter((b) => b.audience === audience).map((b) => b.bytes);
    expect(blobs('draft')).toHaveLength(1);
    for (const blob of blobs('published')) {
      expect(anyKeyOpensBlob({ keys: found, ids, target: at('published'), blob })).toBe(true);
    }
    for (const blob of blobs('draft')) {
      expect(anyKeyOpensBlob({ keys: found, ids, target: at('draft'), blob })).toBe(false);
    }
  });
});
