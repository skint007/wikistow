// The trash (protocol section 10): what is deleted leaves every answer at
// once, for members and agents and for the owners themselves, until it is
// restored, and only owners see or restore it.
import {
  copyOperations as copies,
  pageOperations as pages,
  RevisionId,
  spaceOperations,
  trashOperations as trash,
  utf8,
  type FolderId,
  type SpaceId,
} from '@wikistow/client';
import { pageRoutes } from '@wikistow/contracts';
import { fileBlobStore, schema, sweepTrash } from '@wikistow/server';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { asAgentOf, asPerson, everyAnswer } from './support/opens.ts';
import { ABOVE, invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const nodesOf = async (spaceId: SpaceId) =>
  (
    await t.db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(eq(schema.nodes.spaceId, spaceId))
  ).map((row) => row.id);

const revisionsOf = async (spaceId: SpaceId) =>
  (
    await t.db
      .select({ id: schema.revisions.id })
      .from(schema.revisions)
      .where(eq(schema.revisions.spaceId, spaceId))
  ).map((row) => row.id);

const trashIdOf = async (owner: Person, nodeId: string) => {
  const entry = (await trash.loadTrash(owner.ctx)).find((item) => item.nodeId === nodeId);
  if (!entry) throw new Error(`expected ${nodeId} in the trash`);
  return entry.trashId;
};

const pageAnswers = (statuses: Record<string, number>) =>
  Object.entries(statuses).filter(([key]) => /^(page|history|blob):/.test(key));

describe('the trash', () => {
  it('takes what is deleted out of every answer, for everyone, until it is restored', async () => {
    const owner = await personWithVault(t);
    const member = await personWithVault(t);
    const lib = await library(owner);
    const photo = await pages.uploadAttachment(owner.ctx, lib.page, {
      name: 'photo.jpg',
      mediaType: 'image/jpeg',
      bytes: utf8('photo bytes'),
    });
    await pages.editDraft(owner.ctx, lib.page, { attachments: [photo] });
    await pages.publishPage(owner.ctx, lib.page);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(owner, member, 'editor')],
    });
    const agent = await enrolledAgent(t, owner, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'reader' }],
    });
    const before = await pages.loadPage(owner.ctx, lib.page.pageId);
    const ask = { spaceId: lib.spaceId, ownerId: owner.ctx.identity.public.id };
    const askers = { member: asPerson(member), agent: asAgentOf(t, agent) };
    for (const asker of Object.values(askers)) {
      const { statuses } = await everyAnswer(t, asker, ask);
      expect(statuses[`page:${lib.page.pageId}`]).toBe(200);
    }

    await pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: lib.above });
    const gone = [...(await nodesOf(lib.spaceId)), ...(await revisionsOf(lib.spaceId))];
    expect(gone.length).toBeGreaterThan(6);

    // Members and agents get no trace of it, by any route.
    for (const [who, asker] of Object.entries(askers)) {
      const { text, statuses } = await everyAnswer(t, asker, ask);
      expect(
        gone.filter((id) => text.includes(id)),
        who,
      ).toEqual([]);
      expect(new Set(pageAnswers(statuses).map(([, status]) => status)), who).toEqual(
        new Set([404]),
      );
    }
    expect(await spaceOperations.loadTree(member.ctx, lib.spaceId).catch(() => null)).toBeNull();

    // Nor do the owners, but in the trash: their tree, pages and files are gone.
    const { statuses } = await everyAnswer(t, asPerson(owner), ask);
    expect(new Set(pageAnswers(statuses).map(([, status]) => status))).toEqual(new Set([404]));
    expect(statuses[`target:${lib.shared}`]).toBe(404);
    const tree = await spaceOperations.loadTree(owner.ctx, lib.spaceId);
    expect([...tree.folders, ...tree.pages]).toEqual([]);

    const [entry, ...rest] = await trash.loadTrash(owner.ctx);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      nodeId: lib.above,
      kind: 'folder',
      title: ABOVE,
      deletedBy: expect.any(String),
    });
    if (!entry) throw new Error('expected the folder in the trash');

    // Only owners see the trash, and agents never.
    expect(await trash.loadTrash(member.ctx)).toEqual([]);
    expect(await rejection(trash.restoreTrash(member.ctx, entry.trashId))).toBe('not-found');
    expect(await rejection(trash.purgeTrash(member.ctx, entry.trashId))).toBe('not-found');
    const revisions = (await revisionsOf(lib.spaceId)).map((id) => RevisionId.parse(id));
    const asked = await member.api.call(pageRoutes.trashRevisions, { body: { ids: revisions } });
    expect(asked.revisions).toEqual([]);
    expect((await asAgent(t, agent.token, '/api/trash')).status).not.toBe(200);
    expect(
      (await asAgent(t, agent.token, `/api/trash/${entry.trashId}/restore`, { method: 'POST' }))
        .status,
    ).not.toBe(200);

    // Restored, it is all back where it was: versions, files, share, publication.
    expect(await trash.restoreTrash(owner.ctx, entry.trashId)).toEqual({
      spaceId: lib.spaceId,
      nodeId: lib.above,
      parentId: null,
    });
    expect(await trash.loadTrash(owner.ctx)).toEqual([]);
    const after = await pages.loadPage(owner.ctx, lib.page.pageId);
    expect(after.heads).toEqual(before.heads);
    for (const [who, asker] of Object.entries(askers)) {
      const { statuses } = await everyAnswer(t, asker, ask);
      expect(statuses[`page:${lib.page.pageId}`], who).toBe(200);
      expect(statuses[`history:${lib.page.pageId}`], who).toBe(200);
    }
    const shared = await spaceOperations.loadTree(member.ctx, lib.spaceId);
    expect(shared.pages.map((page) => page.id)).toEqual([lib.page.pageId]);
    const opened = await pages.readAttachment(member.ctx, lib.page, 'draft', photo);
    expect(new TextDecoder().decode(opened)).toBe('photo bytes');
  });

  it('puts a page whose folder is in the trash too at the top of its space or shared folder', async () => {
    const owner = await personWithVault(t);
    const member = await personWithVault(t);
    const lib = await library(owner);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(owner, member, 'editor')],
    });
    const inner = await spaceOperations.createFolder(owner.ctx, {
      spaceId: lib.spaceId,
      parentId: lib.shared,
      name: 'Inner',
    });
    const deep = await pages.createPage(owner.ctx, {
      spaceId: lib.spaceId,
      parentId: inner,
      title: 'Deep',
    });
    const remove = (nodeId: string) =>
      pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: nodeId as FolderId });

    // Outside any share: the top of the space.
    await remove(lib.beside.pageId);
    await remove(lib.above);
    expect(await trash.restoreTrash(owner.ctx, await trashIdOf(owner, lib.beside.pageId))).toEqual(
      expect.objectContaining({ parentId: null }),
    );
    await trash.restoreTrash(owner.ctx, await trashIdOf(owner, lib.above));

    // In a shared folder: the top of that folder, which keeps its keys.
    await remove(deep);
    await remove(inner);
    expect(await trash.restoreTrash(owner.ctx, await trashIdOf(owner, deep))).toEqual(
      expect.objectContaining({ parentId: lib.shared }),
    );
    const seen = await spaceOperations.loadTree(member.ctx, lib.spaceId);
    expect(seen.pages.find((page) => page.id === deep)).toMatchObject({
      parentId: lib.shared,
      title: 'Deep',
    });

    // With the shared folder in the trash too, it waits for what holds it.
    await remove(lib.above);
    const refused = await trash
      .restoreTrash(owner.ctx, await trashIdOf(owner, inner))
      .catch((error: { code?: string; detail?: { nodeIds?: string[] } }) => error);
    expect(refused).toMatchObject({ code: 'region-mismatch', detail: { nodeIds: [lib.above] } });
    await trash.restoreTrash(owner.ctx, await trashIdOf(owner, lib.above));
    await trash.restoreTrash(owner.ctx, await trashIdOf(owner, inner));
    const back = await spaceOperations.loadTree(member.ctx, lib.spaceId);
    expect(back.folders.map((folder) => folder.id).sort()).toEqual([inner, lib.shared].sort());
  });

  it('keeps what was deleted from a folder that moves to another space', async () => {
    const owner = await personWithVault(t);
    const member = await personWithVault(t);
    const lib = await library(owner);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.above,
      people: [await invite(owner, member, 'editor')],
    });
    const elsewhere = await spaceOperations.createSpace(owner.ctx, { name: 'Elsewhere' });
    await pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: lib.page.pageId });
    const preview = await copies.previewCopy(owner.ctx, {
      kind: 'move',
      source: { spaceId: lib.spaceId, nodeId: lib.shared },
      destination: { spaceId: elsewhere, parentId: null },
    });
    await copies.makeCopy(owner.ctx, preview);
    // It comes back beside where the folder was, in the share its keys are for.
    expect(await trash.restoreTrash(owner.ctx, await trashIdOf(owner, lib.page.pageId))).toEqual(
      expect.objectContaining({ parentId: lib.above }),
    );
    const seen = await spaceOperations.loadTree(member.ctx, lib.spaceId);
    expect(seen.pages.find((page) => page.id === lib.page.pageId)).toMatchObject({
      parentId: lib.above,
      title: 'Plan',
    });
  });

  it('lets what was deleted from a shared folder go with it when the folder moves away', async () => {
    const owner = await personWithVault(t);
    const member = await personWithVault(t);
    const lib = await library(owner);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(owner, member, 'editor')],
    });
    const elsewhere = await spaceOperations.createSpace(owner.ctx, { name: 'Elsewhere' });
    await pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: lib.page.pageId });
    const preview = await copies.previewCopy(owner.ctx, {
      kind: 'move',
      source: { spaceId: lib.spaceId, nodeId: lib.shared },
      destination: { spaceId: elsewhere, parentId: null },
    });
    await copies.makeCopy(owner.ctx, preview);
    // Its keys were the share's, which went with the move, so nobody could open it.
    expect(await trash.loadTrash(owner.ctx)).toEqual([]);
    expect(await nodesOf(lib.spaceId)).not.toContain(lib.page.pageId);
  });

  it('deletes for good one item, a space’s whole trash, or what has waited 30 days', async () => {
    const owner = await personWithVault(t);
    const lib = await library(owner);
    const store = fileBlobStore(t.blobDir);
    const photo = await pages.uploadAttachment(owner.ctx, lib.page, {
      name: 'photo.jpg',
      mediaType: 'image/jpeg',
      bytes: utf8('photo bytes to delete'),
    });
    await pages.editDraft(owner.ctx, lib.page, { attachments: [photo] });
    const remove = (nodeId: string) =>
      pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: nodeId as FolderId });

    // A page deleted before its folder goes with the folder.
    await remove(lib.page.pageId);
    await remove(lib.shared);
    await trash.purgeTrash(owner.ctx, await trashIdOf(owner, lib.shared));
    expect(await trash.loadTrash(owner.ctx)).toEqual([]);
    const left = await t.db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(inArray(schema.nodes.id, [lib.page.pageId, lib.shared]));
    expect(left).toEqual([]);
    expect(
      await t.db.select().from(schema.blobs).where(eq(schema.blobs.pageId, lib.page.pageId)),
    ).toEqual([]);

    await remove(lib.beside.pageId);
    expect(await trash.emptyTrash(owner.ctx, lib.spaceId)).toBe(1);
    expect(await nodesOf(lib.spaceId)).toEqual([lib.above]);

    await remove(lib.above);
    expect(await sweepTrash(t.db, store, { keptMs: 60_000 })).toEqual({ removed: 0, failed: 0 });
    expect(await sweepTrash(t.db, store, { keptMs: 0 })).toMatchObject({ removed: 1, failed: 0 });
    expect(await nodesOf(lib.spaceId)).toEqual([]);
  });
});
