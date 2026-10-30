import {
  FolderId,
  fromBase64,
  MetadataRevisionId,
  newFolderMetadata,
  newId,
  newPayload,
  pageOperations as pages,
  PageId,
  publicationOperations,
  revisionWrapSubject,
  RevisionId,
  sealMetadataV2,
  sealRevisionV2,
  sharingOperations,
  spaceOperations,
  unwrapContentKey,
  utf8,
  type PagePayload,
} from '@wikistow/client';
import { exposes, MARKERS, readableCorpus, stealableKeys } from '@wikistow/client/testing';
import {
  KeyEnvelope,
  KeyEnvelopeV2,
  MetadataEnvelope,
  MetadataEnvelopeV2,
  pageRoutes,
  peopleRoutes,
  RevisionRecordV2,
  structureRoutes,
} from '@wikistow/contracts';
import { z } from 'zod';
import { schema } from '@wikistow/server';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { enrolledAgent } from './support/agents.ts';
import { openCopy } from './support/copies.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { addToGroup, makeGroup, removeFromGroup, shareWithGroup } from './support/groups.ts';
import { asAgentOf, asPerson, everyAnswer, keysOf, whatOpens } from './support/opens.ts';
import { shareFolder } from './support/sharing.ts';
import { snapshot } from './support/snapshot.ts';

let t: TestApp;
let world: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  t = await createTestApp();
  world = await buildWorld();
});
afterAll(() => t.drop());

/** The world's space and folder names. */
const NAMES = {
  space: 'PLAINTEXT-WORLD-SPACE-NAME-5b6c',
  folder: 'PLAINTEXT-WORLD-FOLDER-NAME-7d8e',
};

/**
 * The Milestone 0 story over HTTP: a page with an attachment, in a folder,
 * published, then edited privately, plus a second page that is never
 * published. And an administrator with a vault of their own.
 */
async function buildWorld() {
  const owner = await personWithVault(t, 'user', {
    password: MARKERS.ownerPassword,
    passphrase: MARKERS.ownerPassphrase,
  });
  const spaceId = await spaceOperations.createSpace(owner.ctx, { name: NAMES.space });
  const folderId = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: null,
    name: NAMES.folder,
  });
  const pageId = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: folderId,
    title: MARKERS.title,
    markdown: MARKERS.publishedBody,
  });
  const page = { spaceId, pageId };
  const photo = await pages.uploadAttachment(owner.ctx, page, {
    name: MARKERS.attachmentName,
    mediaType: 'image/jpeg',
    bytes: utf8(MARKERS.attachmentBody),
  });
  await pages.editDraft(owner.ctx, page, { attachments: [photo] });
  await pages.publishPage(owner.ctx, page);
  await pages.editDraft(owner.ctx, page, { markdown: MARKERS.privateBody });
  const otherPage = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: null,
    title: 'Other',
    markdown: MARKERS.privatePageBody,
  });
  const admin = await personWithVault(t, 'admin');
  return { owner, admin, page, folderId, otherPage };
}

const allRevisions = async () =>
  t.db
    .select({
      id: schema.revisions.id,
      spaceId: schema.revisions.spaceId,
      pageId: schema.revisions.pageId,
      audience: schema.revisions.audience,
    })
    .from(schema.revisions);

const AnyEnvelope = z.union([KeyEnvelope, MetadataEnvelope, KeyEnvelopeV2, MetadataEnvelopeV2]);

/** Page and metadata envelopes alike. */
const allEnvelopes = async () =>
  (await t.db.select({ envelope: schema.keyEnvelopes.envelope }).from(schema.keyEnvelopes)).map(
    (row) => AnyEnvelope.parse(row.envelope),
  );

describe('an administrator', () => {
  it('can neither see nor change anyone else’s pages, by any route', async () => {
    const { owner, admin, page, folderId, otherPage } = world;
    const ids = (await allRevisions()).map((r) => RevisionId.parse(r.id));
    const blobs = await t.db.select({ hash: schema.blobs.hash }).from(schema.blobs);
    expect(blobs.length).toBeGreaterThanOrEqual(2);
    const { heads } = await pages.loadPage(owner.ctx, page.pageId);
    if (!heads.draftHead) throw new Error('expected a draft');

    // Admin-signed commits addressed straight at the owner's page.
    const commit = (audience: 'draft' | 'published', payload: PagePayload) => ({
      ...sealRevisionV2({
        author: admin.ctx.identity,
        target: {
          installationId: admin.ctx.installationId,
          ...page,
          revisionId: newId(RevisionId),
          audience,
          basedOn: heads.draftHead,
        },
        payload,
        recipients: [admin.ctx.identity.public],
      }),
      blobRefs: [],
      permissionVersion: 1,
    });
    const payload = newPayload({ title: 'Overwritten', markdown: 'by an admin' });
    const newPage = await (async () => {
      const pageId = newId(PageId);
      const sealed = commit('draft', payload);
      return { ...sealed, pageId, parentId: folderId };
    })();

    const bodies: string[] = [];
    const attempt = async (path: string, init: RequestInit = {}) => {
      const res = await admin.browser.fetch(path, init);
      bodies.push(await res.text());
      return res.status;
    };
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const statuses = {
      page: await attempt(`/api/pages/${page.pageId}`),
      other: await attempt(`/api/pages/${otherPage}`),
      history: await attempt(`/api/pages/${page.pageId}/history`),
      target: await attempt(`/api/spaces/${page.spaceId}/target?nodeId=${page.pageId}`),
      owners: await attempt(`/api/spaces/${page.spaceId}/owners`),
      statements: await attempt(`/api/spaces/${page.spaceId}/owner-statements`),
      myEnvelopes: await attempt(`/api/spaces/${page.spaceId}/my-envelopes`),
      shares: await attempt(`/api/spaces/${page.spaceId}/shares`),
      records: await attempt(`/api/spaces/${page.spaceId}/records?scope=owner-region`),
      createPage: await attempt(`/api/spaces/${page.spaceId}/pages`, json('POST', newPage)),
      saveDraft: await attempt(
        `/api/pages/${page.pageId}/drafts`,
        json('POST', { ...commit('draft', payload), restoredFrom: null }),
      ),
      publish: await attempt(
        `/api/pages/${page.pageId}/publications`,
        json('POST', {
          ...commit('published', payload),
          expectedPublishedHead: heads.publishedHead,
        }),
      ),
      upload: await attempt(`/api/pages/${page.pageId}/blobs?audience=draft`, {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      }),
      delete: await attempt(`/api/spaces/${page.spaceId}/nodes/${folderId}`, { method: 'DELETE' }),
    };
    for (const [route, status] of Object.entries(statuses)) expect(status, route).toBe(404);
    for (const { hash } of blobs) expect(await attempt(`/api/blobs/${hash}`), hash).toBe(404);
    const batch = await admin.api.call(pageRoutes.fetchRevisions, { body: { ids } });
    expect(batch.revisions).toEqual([]);
    expect(
      await rejection(admin.api.call(structureRoutes.tree, { params: { spaceId: page.spaceId } })),
    ).toBe('not-found');
    expect((await admin.api.call(structureRoutes.listSpaces)).spaces).toEqual([]);

    // A folder, and new names for the real folder and space, based on their real heads.
    const name = (
      subjectKind: 'space' | 'folder',
      subjectId: string,
      basedOn: MetadataRevisionId | null,
    ) =>
      sealMetadataV2({
        author: admin.ctx.identity,
        target: {
          installationId: admin.ctx.installationId,
          spaceId: page.spaceId,
          subjectKind,
          subjectId,
          metadataRevisionId: newId(MetadataRevisionId),
          basedOn,
        },
        metadata: newFolderMetadata('Renamed by an admin'),
        recipients: [admin.ctx.identity.public],
      });
    const sneaky = newId(FolderId);
    expect(
      await rejection(
        admin.api.call(structureRoutes.createFolder, {
          params: { spaceId: page.spaceId },
          body: {
            folderId: sneaky,
            parentId: null,
            permissionVersion: 1,
            ...name('folder', sneaky, null),
            wrap: null,
          },
        }),
      ),
    ).toBe('not-found');
    const tree = await spaceOperations.loadTree(owner.ctx, page.spaceId);
    const folder = tree.folders.find((f) => f.id === folderId);
    for (const [subjectKind, subjectId, basedOn] of [
      ['space', page.spaceId, tree.space?.metadata?.head ?? null],
      ['folder', folderId, folder?.metadata?.head ?? null],
    ] as const) {
      expect(
        await rejection(
          admin.api.call(structureRoutes.updateMetadata, {
            params: { spaceId: page.spaceId },
            body: { permissionVersion: 1, ...name(subjectKind, subjectId, basedOn), wrap: null },
          }),
        ),
        subjectKind,
      ).toBe('not-found');
    }
    // Nor does any key in the envelope table unseal for them, though the owner's all do.
    const envelopes = await allEnvelopes();
    expect(stealableKeys(envelopes, admin.vault.identity)).toEqual([]);
    expect(stealableKeys(envelopes, owner.vault.identity)).toHaveLength(envelopes.length);

    // Nothing the admin was sent names the content, and nothing changed.
    const seen = bodies.join('\n') + JSON.stringify(batch);
    for (const marker of Object.values(MARKERS)) expect(seen).not.toContain(marker);
    expect((await pages.loadPage(owner.ctx, page.pageId)).heads).toEqual(heads);
    expect(await allRevisions()).toHaveLength(ids.length);
  });
});

/**
 * A member who holds only one folder of someone else's space, as a reader:
 * the folder sits inside another whose name, like the space's and a private
 * page beside it, must never reach them.
 */
async function memberWorld() {
  const owner = await personWithVault(t);
  const reader = await personWithVault(t);
  const spaceId = await spaceOperations.createSpace(owner.ctx, { name: OUTSIDE.space });
  const above = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: null,
    name: OUTSIDE.ancestor,
  });
  const shared = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: above,
    name: 'Shared with the reader',
  });
  const inside = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: shared,
    title: 'Inside',
    markdown: 'published inside',
  });
  const insidePage = { spaceId, pageId: inside };
  await pages.publishPage(owner.ctx, insidePage);
  await pages.editDraft(owner.ctx, insidePage, { markdown: OUTSIDE.draft });
  // Published, so only the region and the share keep it from a reader.
  const beside = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: above,
    title: OUTSIDE.title,
    markdown: OUTSIDE.body,
  });
  await pages.publishPage(owner.ctx, { spaceId, pageId: beside });
  // Another share in the space, which the reader isn't in.
  const elsewhere = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: above,
    name: OUTSIDE.otherShare,
  });
  const otherPage = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: elsewhere,
    title: OUTSIDE.title,
    markdown: OUTSIDE.otherBody,
  });
  await pages.publishPage(owner.ctx, { spaceId, pageId: otherPage });
  const otherShare = await shareFolder(owner.ctx, { spaceId, rootId: elsewhere, people: [] });
  const found = await sharingOperations.findPerson(owner.ctx, reader.email);
  if (!found) throw new Error('expected to find the reader');
  const shareId = await shareFolder(owner.ctx, {
    spaceId,
    rootId: shared,
    people: [{ person: found, role: 'reader' }],
  });
  return {
    owner,
    reader,
    spaceId,
    above,
    shared,
    insidePage,
    beside,
    elsewhere,
    otherPage,
    shareId,
    otherShare,
  };
}

const OUTSIDE = {
  space: 'PLAINTEXT-SPACE-NAME-ab12',
  ancestor: 'PLAINTEXT-ANCESTOR-NAME-cd34',
  title: 'PLAINTEXT-PRIVATE-TITLE-ef56',
  body: 'PLAINTEXT-PRIVATE-BODY-0789',
  draft: 'PLAINTEXT-SHARED-DRAFT-1a2b',
  otherShare: 'PLAINTEXT-OTHER-SHARE-NAME-3c4d',
  otherBody: 'PLAINTEXT-OTHER-SHARE-BODY-5e6f',
};

/** Whose space `memberWorld` is, for `everyAnswer`. */
const ownerOf = (m: Awaited<ReturnType<typeof memberWorld>>) => ({
  spaceId: m.spaceId,
  ownerId: m.owner.vault.identity.public.id,
});

/** What a copy's reader reads in another space, which still never sits on the server as plaintext. */
const COPY = {
  title: 'PLAINTEXT-COPY-TITLE-9f0a',
  body: 'PLAINTEXT-COPY-BODY-1b2c',
  file: 'PLAINTEXT-COPY-FILE-3d4e.txt',
  bytes: 'PLAINTEXT-COPY-BYTES-5f6a',
};

/**
 * `memberWorld`, its page inside published again with `COPY`'s text and
 * file, and that publication sent into a folder of the owner's Board,
 * which `copyReader` reads.
 */
async function copyWorld() {
  const m = await memberWorld();
  const { owner, insidePage } = m;
  const copyReader = await personWithVault(t);
  const board = await spaceOperations.createSpace(owner.ctx, { name: 'Board' });
  const pinned = await spaceOperations.createFolder(owner.ctx, {
    spaceId: board,
    parentId: null,
    name: 'Pinned',
  });
  const found = await sharingOperations.findPerson(owner.ctx, copyReader.email);
  if (!found) throw new Error('expected to find the reader');
  const boardShare = await shareFolder(owner.ctx, {
    spaceId: board,
    rootId: pinned,
    people: [{ person: found, role: 'reader' }],
  });
  const file = await pages.uploadAttachment(owner.ctx, insidePage, {
    name: COPY.file,
    mediaType: 'text/plain',
    bytes: utf8(COPY.bytes),
  });
  await pages.editDraft(owner.ctx, insidePage, {
    title: COPY.title,
    markdown: COPY.body,
    attachments: [file],
  });
  const { revisionId } = await pages.publishPage(owner.ctx, insidePage);
  const preview = await publicationOperations.previewPublication(owner.ctx, {
    source: insidePage,
    revisionId,
    audience: 'published',
    spaceId: board,
    parentId: pinned,
  });
  const copy = await publicationOperations.publishToSpace(owner.ctx, {
    preview,
    attachmentIds: new Set([file.id]),
  });
  return { ...m, copyReader, board, boardShare, copy };
}

describe('a member of one folder', () => {
  it('is sent nothing about what is outside it, by any route', async () => {
    const m = await memberWorld();
    const { text, statuses } = await everyAnswer(t, asPerson(m.reader), ownerOf(m));

    // Outside the folder is not-found; the folder and its page answer.
    for (const id of [m.above, m.beside, m.elsewhere, m.otherPage]) {
      expect(statuses[`target:${id}`], id).toBe(404);
    }
    for (const id of [m.beside, m.otherPage]) {
      expect(statuses[`page:${id}`], id).toBe(404);
      expect(statuses[`history:${id}`], id).toBe(404);
    }
    expect(statuses[`target:${m.shared}`]).toBe(200);
    expect(statuses['spaceTarget']).toBe(404);
    expect(statuses['shares']).toBe(403);
    expect(statuses['records']).toBe(403);
    expect(statuses[`envelopes:${m.shareId}:1`]).toBe(200);
    expect(statuses[`envelopes:${m.otherShare}:1`]).toBe(404);

    for (const id of [m.above, m.beside, m.elsewhere, m.otherPage, m.otherShare]) {
      expect(text).not.toContain(id);
    }
    for (const marker of Object.values(OUTSIDE)) expect(text).not.toContain(marker);
    // Only published versions of the page inside reach a reader.
    const ids = (await allRevisions()).map((r) => RevisionId.parse(r.id));
    const batch = await m.reader.api.call(pageRoutes.fetchRevisions, { body: { ids } });
    const sentIds = batch.revisions.map((r) => r.revision.record.revisionId);
    const published = (await allRevisions()).filter(
      (r) => r.pageId === m.insidePage.pageId && r.audience === 'published',
    );
    expect(sentIds.sort()).toEqual(published.map((r) => r.id).sort());
    expect(batch.revisions.every((r) => r.wrap?.shareId === m.shareId)).toBe(true);
  });

  it('holds keys that open nothing outside the folder, and no draft', async () => {
    const m = await memberWorld();
    const { reader } = m;
    await spaceOperations.loadTree(reader.ctx, m.spaceId);
    // Their folder keys: the share's published key only.
    const held = reader.ctx.keyring.versions(m.spaceId, m.shareId);
    expect(held.map((h) => [h.keyVersion, h.draftKey])).toEqual([[1, null]]);
    // Everything stored, tried with every key they hold: only the folder's
    // published versions and name open, and they say nothing of what is outside.
    const opens = await whatOpens(t, keysOf(reader));
    expect(opens.revisions.length).toBeGreaterThan(0);
    for (const { record, text } of opens.revisions) {
      expect(record.audience).toBe('published');
      expect(record.pageId).toBe(m.insidePage.pageId);
      for (const marker of Object.values(OUTSIDE)) expect(text).not.toContain(marker);
    }
    expect(opens.names).toEqual(new Set([m.shared]));
    // A control: the owner's keys open the name above it.
    expect((await whatOpens(t, keysOf(m.owner))).names.has(m.above)).toBe(true);
  });
});

/** A group's name, which only the space's owners ever read. */
const GROUP = 'PLAINTEXT-GROUP-NAME-7a8b';

/**
 * `memberWorld`'s folder shared with a group too, named `GROUP`, holding a
 * member and someone since removed from it, and a whole space of the
 * owner's, with a group of its own, shared with the member afterwards.
 */
async function groupWorld() {
  const m = await memberWorld();
  const { owner, spaceId, shareId } = m;
  const [member, removed] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const groupId = await makeGroup(owner, spaceId, GROUP);
  await addToGroup(owner, spaceId, groupId, member);
  await addToGroup(owner, spaceId, groupId, removed);
  await shareWithGroup(owner, {
    spaceId,
    shareId,
    groupId,
    access: { role: 'reader', canPublish: false },
    sealTo: [member, removed],
  });
  await spaceOperations.loadTree(removed.ctx, spaceId);
  expect(await removeFromGroup(owner, spaceId, groupId, removed)).toEqual([shareId]);
  // A group made before the whole space is shared stays in the owner region.
  const whole = await spaceOperations.createSpace(owner.ctx, { name: 'Whole' });
  const wholeGroup = await makeGroup(owner, whole, GROUP);
  const found = await sharingOperations.findPerson(owner.ctx, member.email);
  if (!found) throw new Error('expected to find the member');
  await shareFolder(owner.ctx, {
    spaceId: whole,
    rootId: null,
    people: [{ person: found, role: 'editor' }],
  });
  return { ...m, member, removed, groupId, whole, wholeGroup };
}

describe('a group member, and someone removed from the group', () => {
  it('are sent no group name and nothing outside the folder, by any route', async () => {
    const g = await groupWorld();
    const member = await everyAnswer(t, asPerson(g.member), ownerOf(g));
    expect(member.statuses[`target:${g.shared}`]).toBe(200);
    expect(member.statuses['groups']).toBe(403);
    const removed = await everyAnswer(t, asPerson(g.removed), ownerOf(g));
    for (const key of [`target:${g.shared}`, 'myEnvelopes', 'tree', 'groups']) {
      expect(removed.statuses[key], key).toBe(404);
    }
    expect(removed.statuses[`envelopes:${g.shareId}:2`]).toBe(404);
    const whole = await everyAnswer(t, asPerson(g.member), {
      spaceId: g.whole,
      ownerId: g.owner.vault.identity.public.id,
    });
    expect(whole.statuses['tree']).toBe(200);
    for (const text of [member.text, removed.text, whole.text]) {
      for (const marker of [GROUP, g.groupId, g.wholeGroup, ...Object.values(OUTSIDE)]) {
        expect(text).not.toContain(marker);
      }
    }
  });

  it('hold keys that open no group name', async () => {
    const g = await groupWorld();
    await spaceOperations.loadTree(g.member.ctx, g.whole);
    for (const person of [g.member, g.removed]) {
      const { names } = await whatOpens(t, keysOf(person));
      expect(names.has(g.groupId)).toBe(false);
      expect(names.has(g.wholeGroup)).toBe(false);
    }
    // The member holds the whole space's keys, so the control is real.
    expect((await whatOpens(t, keysOf(g.member))).names.has(g.whole)).toBe(true);
    const owner = await whatOpens(t, keysOf(g.owner));
    expect([owner.names.has(g.groupId), owner.names.has(g.wholeGroup)]).toEqual([true, true]);
  });
});

describe('a reader of a page published from another space', () => {
  it('is sent nothing of the source or what is around it, and holds no key to it', async () => {
    const m = await copyWorld();
    const { insidePage, copyReader, board, boardShare } = m;
    const { pageId } = m.copy;

    const bodies: string[] = [];
    const get = async (path: string) => {
      const res = await copyReader.browser.fetch(path, { method: 'GET' });
      bodies.push(await res.text());
      return res.status;
    };
    const sourceNodes = await t.db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(eq(schema.nodes.spaceId, m.spaceId));
    const ids = (await allRevisions()).map((r) => RevisionId.parse(r.id));
    const statuses: Record<string, number> = {
      spaces: await get('/api/spaces'),
      sharedWithMe: await get('/api/shared-with-me'),
      boardTree: await get(`/api/spaces/${board}/tree`),
      copy: await get(`/api/pages/${pageId}`),
      copyHistory: await get(`/api/pages/${pageId}/history`),
      sourceTree: await get(`/api/spaces/${m.spaceId}/tree`),
      lookup: await get(`/api/pages/${insidePage.pageId}/publications/${board}`),
      sourceEnvelopes: await get(`/api/shares/${m.shareId}/versions/1/envelopes`),
    };
    for (const { id } of sourceNodes) {
      statuses[`page:${id}`] = await get(`/api/pages/${id}`);
      statuses[`history:${id}`] = await get(`/api/pages/${id}/history`);
    }
    const batch = await copyReader.api.call(pageRoutes.fetchRevisions, { body: { ids } });
    bodies.push(JSON.stringify(batch));

    for (const route of ['spaces', 'sharedWithMe', 'boardTree', 'copy', 'copyHistory']) {
      expect(statuses[route], route).toBe(200);
    }
    for (const route of ['sourceTree', 'lookup', 'sourceEnvelopes']) {
      expect(statuses[route], route).toBe(404);
    }
    for (const { id } of sourceNodes) {
      expect(statuses[`page:${id}`], id).toBe(404);
      expect(statuses[`history:${id}`], id).toBe(404);
    }
    // Which page it came from is only inside the copy's encrypted payload.
    const seen = bodies.join('\n');
    for (const id of [m.spaceId, m.shareId, ...sourceNodes.map((n) => n.id)]) {
      expect(seen).not.toContain(id);
    }
    for (const marker of Object.values(OUTSIDE)) expect(seen).not.toContain(marker);
    const copies = (await allRevisions()).filter((r) => r.pageId === pageId);
    expect(batch.revisions.map((r) => r.revision.record.revisionId)).toEqual(
      copies.map((r) => r.id),
    );

    // Its keys open the copy, and nothing of the source.
    expect(stealableKeys(await allEnvelopes(), copyReader.vault.identity)).toEqual([]);
    const opened = await pages.openRevisionOf(
      copyReader.ctx,
      { spaceId: board, pageId },
      'published',
      RevisionId.parse(copies[0]?.id),
    );
    expect(copyReader.ctx.keyring.versions(board, boardShare).map((h) => h.draftKey)).toEqual([
      null,
    ]);
    const wraps = await t.db
      .select({ sealed: schema.revisions.sealed, wrap: schema.revisionWraps.wrap })
      .from(schema.revisionWraps)
      .innerJoin(schema.revisions, eq(schema.revisions.id, schema.revisionWraps.revisionId));
    const unwrapped = wraps.flatMap(({ sealed, wrap }) => {
      const record = RevisionRecordV2.parse((sealed as { record?: unknown } | undefined)?.record);
      try {
        unwrapContentKey({
          installationId: copyReader.ctx.installationId,
          subject: revisionWrapSubject(record),
          wrap,
          keyring: copyReader.ctx.keyring,
          commitment: record.keyCommitment,
        });
        return [record.pageId];
      } catch {
        return [];
      }
    });
    expect(new Set(unwrapped)).toEqual(new Set([pageId]));
    // Nor does the copy name anything around the source.
    const plain = JSON.stringify(opened.opened);
    for (const marker of Object.values(OUTSIDE)) expect(plain).not.toContain(marker);
  });
});

describe('a copy not finished yet', () => {
  it('is sent to nobody, its opener included, by any route', async () => {
    const m = await memberWorld();
    // The owner copies the shared folder into a folder of the Board that
    // the reader edits there, and into the Board's owner region, and sends
    // everything but the finishes.
    const board = await spaceOperations.createSpace(m.owner.ctx, { name: 'Board' });
    const pinned = await spaceOperations.createFolder(m.owner.ctx, {
      spaceId: board,
      parentId: null,
      name: 'Pinned',
    });
    const found = await sharingOperations.findPerson(m.owner.ctx, m.reader.email);
    if (!found) throw new Error('expected to find the reader');
    await shareFolder(m.owner.ctx, {
      spaceId: board,
      rootId: pinned,
      people: [{ person: found, role: 'editor', canPublish: true }],
    });
    const copy = await openCopy(m.owner.ctx, {
      from: m.spaceId,
      nodeId: m.shared,
      to: board,
      parentId: pinned,
    });
    const owned = await openCopy(m.owner.ctx, {
      from: m.spaceId,
      nodeId: m.shared,
      to: board,
      parentId: null,
    });
    for (const each of [copy, owned]) {
      await each.open();
      await each.send();
    }
    const hidden = [copy, owned].flatMap((each) => each.sourceIds.map((id) => each.newIdOf(id)));
    const sent = (await allRevisions()).filter((r) => hidden.includes(r.pageId));
    expect(sent.length).toBeGreaterThan(0);

    const at = { spaceId: board, ownerId: m.owner.vault.identity.public.id };
    for (const asker of [asPerson(m.reader), asPerson(m.owner)]) {
      const { text, statuses } = await everyAnswer(t, asker, at);
      expect(statuses['tree']).toBe(200);
      // The owner's scan of the owner region, for a new co-owner, too.
      if (asker.api === m.owner.api) expect(statuses['records']).toBe(200);
      for (const id of hidden) {
        expect(text).not.toContain(id);
        expect(statuses[`target:${id}`], id).toBe(404);
      }
      for (const { pageId } of sent) {
        expect(statuses[`page:${pageId}`], pageId).toBe(404);
        expect(statuses[`history:${pageId}`], pageId).toBe(404);
      }
      for (const { id } of sent) expect(text).not.toContain(id);
      const files = await t.db
        .select({ hash: schema.blobs.hash })
        .from(schema.blobs)
        .where(inArray(schema.blobs.pageId, hidden));
      for (const { hash } of files) expect(statuses[`blob:${hash}`], hash).toBe(404);
    }
    await copy.cancel();
    await owned.cancel();
  });
});

describe('an agent picked into one folder', () => {
  // The reader of `memberWorld` enrolls an agent with the shared folder.
  async function agentWorld() {
    const m = await memberWorld();
    const agent = await enrolledAgent(t, m.reader, {
      picks: [{ spaceId: m.spaceId, folderId: m.shared, role: 'reader' }],
    });
    return { ...m, agent };
  }

  it('is sent nothing about what is outside its pick, by any route', async () => {
    const m = await agentWorld();
    const { agent } = m;
    const { text, statuses } = await everyAnswer(t, asAgentOf(t, agent), ownerOf(m));

    for (const id of [m.above, m.beside, m.elsewhere, m.otherPage]) {
      expect(statuses[`target:${id}`], id).toBe(404);
    }
    for (const id of [m.beside, m.otherPage]) {
      expect(statuses[`page:${id}`], id).toBe(404);
      expect(statuses[`history:${id}`], id).toBe(404);
    }
    expect(statuses[`target:${m.shared}`]).toBe(200);
    expect(statuses[`page:${m.insidePage.pageId}`]).toBe(200);
    expect(statuses['spaceTarget']).toBe(404);
    expect(statuses[`envelopes:${m.otherShare}:1`]).toBe(404);
    // Owner routes and the owner's name records are for people only.
    for (const route of ['owners', 'statements', 'records']) expect(statuses[route]).toBe(401);
    // Its person's record is sealed to it. It may look up the authors of
    // what it reads, here the owner, and nobody else.
    expect(statuses['contacts']).toBe(200);
    const outsider = await personWithVault(t);
    const looked = await agent.api.call(peopleRoutes.directory, {
      query: { ids: `${m.owner.vault.identity.public.id},${outsider.vault.identity.public.id}` },
    });
    expect(looked.people.map((p) => p.identity.id)).toEqual([m.owner.vault.identity.public.id]);

    for (const id of [m.above, m.beside, m.elsewhere, m.otherPage, m.otherShare]) {
      expect(text).not.toContain(id);
    }
    for (const marker of Object.values(OUTSIDE)) expect(text).not.toContain(marker);
    // Only the published versions of the page inside reach a reader's agent.
    const ids = (await allRevisions()).map((r) => RevisionId.parse(r.id));
    const batch = await agent.api.call(pageRoutes.fetchRevisions, { body: { ids } });
    const sentIds = batch.revisions.map((r) => r.revision.record.revisionId);
    const published = (await allRevisions()).filter(
      (r) => r.pageId === m.insidePage.pageId && r.audience === 'published',
    );
    expect(sentIds.sort()).toEqual(published.map((r) => r.id).sort());
    expect(batch.revisions.every((r) => r.wrap?.shareId === m.shareId)).toBe(true);
  });
});

describe('a snapshot of the database, blob files, logs, and mail', () => {
  it('contains no plaintext, private keys, vault keys, or content keys', async () => {
    const { owner } = world;
    // A share with names above and beside it, and a copy sent from it into another space.
    const m = await copyWorld();
    const { opened } = await pages.openRevisionOf(
      m.copyReader.ctx,
      { spaceId: m.board, pageId: m.copy.pageId },
      'published',
      m.copy.revisionId,
    );
    expect(opened).toMatchObject({
      payload: { title: COPY.title, markdown: COPY.body, attachments: [{ name: COPY.file }] },
    });
    const corpus = readableCorpus(await snapshot(t));

    for (const marker of Object.values(MARKERS)) {
      const token = marker.match(/PLAINTEXT-[A-Z-]+-\w+/)?.[0];
      if (!token) throw new Error(`marker without token: ${marker}`);
      expect(exposes(corpus, utf8(marker)), marker).toBe(false);
      expect(exposes(corpus, utf8(token)), token).toBe(false);
    }
    await groupWorld();
    const marked = [
      ...Object.values(NAMES),
      ...Object.values(OUTSIDE),
      ...Object.values(COPY),
      GROUP,
    ];
    // The copy's record of where it came from is inside its payload too.
    for (const marker of [...marked, 'wikistow.publication', 'sourceRecordHash']) {
      expect(exposes(corpus, utf8(marker)), marker).toBe(false);
    }

    const { identity, vaultKey } = owner.vault;
    const privateKeys = [identity.boxSecretKey, identity.signSecretKey];
    const recoveryKey = Buffer.from(owner.recoveryKey.replaceAll('-', ''), 'hex');
    for (const secret of [...privateKeys, identity.signSecretKey.subarray(0, 32), vaultKey]) {
      expect(exposes(corpus, secret)).toBe(false);
    }
    expect(recoveryKey.length).toBeGreaterThanOrEqual(16);
    expect(exposes(corpus, recoveryKey)).toBe(false);
    expect(corpus.includes(owner.recoveryKey)).toBe(false);

    const contentKeys = stealableKeys(await allEnvelopes(), identity);
    const attachmentKeys = [];
    // The owner's own pages; other tests' spaces belong to other people.
    const own = (await allRevisions()).filter((r) => r.spaceId === world.page.spaceId);
    for (const { id, pageId, audience } of own) {
      const page = { spaceId: world.page.spaceId, pageId: PageId.parse(pageId) };
      const revisionId = RevisionId.parse(id);
      const { opened } = await pages.openRevisionOf(owner.ctx, page, audience, revisionId);
      if (opened.kind === 'current')
        attachmentKeys.push(...opened.payload.attachments.map((ref) => fromBase64(ref.key)));
    }
    expect(contentKeys.length).toBeGreaterThan(5);
    expect(attachmentKeys.length).toBeGreaterThanOrEqual(2);
    for (const key of [...contentKeys, ...attachmentKeys]) expect(exposes(corpus, key)).toBe(false);

    // A control, so a broken search can't make the checks above pass.
    expect(exposes(corpus, fromBase64(identity.public.boxPublicKey))).toBe(true);
    expect(corpus.includes(utf8(world.page.pageId))).toBe(true);
    expect(corpus.includes(utf8(m.copy.pageId))).toBe(true);
    expect(t.logs.length).toBeGreaterThan(0);
    expect(t.mails.length).toBeGreaterThan(0);
  });
});
