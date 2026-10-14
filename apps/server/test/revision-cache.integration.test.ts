import {
  moveOperations as moves,
  newPayload,
  pageOperations as pages,
  spaceOperations,
} from '@wikistow/client';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { draftHead, invite, shareFolder } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

describe('revision downloads through the real client', () => {
  it('opens write regions fresh after a share and after a move', async () => {
    const owner = await personWithVault(t);
    const other = await personWithVault(t);
    const spaceId = await spaceOperations.createSpace(owner.ctx, { name: 'Notes' });
    const shared = await spaceOperations.createFolder(owner.ctx, {
      spaceId,
      parentId: null,
      name: 'Shared',
    });
    const pageId = await pages.createPage(owner.ctx, {
      spaceId,
      parentId: shared,
      title: 'Moving',
    });
    const page = { spaceId, pageId };
    const { heads } = await pages.loadPage(owner.ctx, pageId);
    if (!heads.draftHead) throw new Error('expected a draft');
    const original = await pages.openRevisionOf(owner.ctx, page, 'draft', heads.draftHead);
    expect(original.region.kind).toBe('owner');
    const shareId = await shareFolder(owner.ctx, {
      spaceId,
      rootId: shared,
      people: [await invite(owner, other, 'editor')],
    });
    const written = await pages.saveDraft(owner.ctx, {
      page,
      basedOn: heads.draftHead,
      payload: newPayload({ title: 'Shared now', markdown: 'saved' }),
    });
    expect(written.region).toEqual({ kind: 'share', spaceId, shareId });
    const preview = await moves.previewMove(owner.ctx, { spaceId, nodeId: pageId, parentId: null });
    await moves.moveNode(owner.ctx, { preview });
    expect(
      (await pages.openRevisionOf(owner.ctx, page, 'draft', written.revisionId)).region.kind,
    ).toBe('share');
    const published = await pages.publishPage(owner.ctx, page);
    expect(published.region.kind).toBe('owner');
    const restored = await pages.restorePublished(owner.ctx, page, published.revisionId);
    expect(restored.region.kind).toBe('owner');
  });

  it('saves past a remembered region a share elsewhere left behind', async () => {
    const owner = await personWithVault(t);
    const other = await personWithVault(t);
    const spaceId = await spaceOperations.createSpace(owner.ctx, { name: 'Notes' });
    const folder = await spaceOperations.createFolder(owner.ctx, {
      spaceId,
      parentId: null,
      name: 'Shared',
    });
    const pageId = await pages.createPage(owner.ctx, { spaceId, parentId: folder, title: 'Notes' });
    const page = { spaceId, pageId };
    const first = await pages.saveDraft(owner.ctx, {
      page,
      basedOn: await draftHead(owner, page),
      payload: newPayload({ title: 'Notes', markdown: 'first' }),
    });
    expect(first.region.kind).toBe('owner');
    // Another tab shares the folder; this editor still remembers the owner region.
    const shareId = await shareFolder(owner.ctx, {
      spaceId,
      rootId: folder,
      people: [await invite(owner, other, 'editor')],
    });
    const second = await pages.saveDraft(owner.ctx, {
      page,
      basedOn: first.revisionId,
      basedOnRegion: first.region,
      payload: newPayload({ title: 'Notes', markdown: 'second' }),
    });
    expect(second.region).toEqual({ kind: 'share', spaceId, shareId });
    expect(await draftHead(owner, page)).toBe(second.revisionId);
  });
});
