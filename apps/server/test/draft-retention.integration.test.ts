import {
  newId,
  newPayload,
  pageOperations as pages,
  publicationOperations as publications,
  RevisionId,
  sealRevisionV2,
  spaceOperations as spaces,
  type PagePayload,
  type SpaceId,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import { fileBlobStore, schema, storeRevision, sweepBlobs, sweepDrafts } from '@wikistow/server';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { draftHead, invite, shareFolder, type Person } from './support/sharing.ts';

const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 40 * DAY);
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

async function pageOf(person: Person) {
  const spaceId = await spaces.createSpace(person.ctx, { name: 'Notes' });
  const pageId = await pages.createPage(person.ctx, {
    spaceId,
    parentId: null,
    title: 'Page',
    markdown: 'First',
  });
  return { spaceId, pageId };
}

/** Store a signed abandoned branch, as legacy or interrupted work may leave. */
async function branch(
  person: Person,
  page: pages.PageRef,
  {
    basedOn = null,
    createdAt = OLD,
    restoredFrom = null,
    payload = newPayload({ title: 'Branch', markdown: 'Old' }),
  }: {
    basedOn?: RevisionId | null;
    createdAt?: Date;
    restoredFrom?: RevisionId | null;
    payload?: PagePayload;
  } = {},
) {
  const revisionId = newId(RevisionId);
  const { permissionVersion, keyTarget } = await writeTargetOf(
    person.ctx,
    page.spaceId,
    page.pageId,
  );
  const commit = {
    ...sealRevisionV2({
      author: person.ctx.identity,
      target: {
        installationId: person.ctx.installationId,
        ...page,
        revisionId,
        audience: 'draft',
        basedOn,
      },
      payload,
      ...keyTarget,
    }),
    permissionVersion,
    blobRefs: payload.attachments.map((a) => a.blobHash),
  };
  await t.db.transaction(async (tx) => {
    const [heads] = await tx
      .select()
      .from(schema.pageHeads)
      .where(eq(schema.pageHeads.pageId, page.pageId))
      .for('update');
    if (!heads) throw new Error('expected heads');
    await storeRevision(tx, commit, {
      accountId: person.id,
      draftSeq: heads.draftCount + 1,
      publishedSeq: null,
      restoredFrom,
      storageBytes: t.config.limits.storageBytes,
    });
    await tx.update(schema.revisions).set({ createdAt }).where(eq(schema.revisions.id, revisionId));
    await tx
      .update(schema.pageHeads)
      .set({ draftCount: heads.draftCount + 1 })
      .where(eq(schema.pageHeads.pageId, page.pageId));
  });
  return revisionId;
}

/** Publish `revisionId` of `source` into `spaceId`, as a new copy or the next version of one. */
const sendCopy = async (
  person: Person,
  source: pages.PageRef,
  spaceId: SpaceId,
  revisionId: RevisionId,
) =>
  publications.publishToSpace(person.ctx, {
    preview: await publications.previewPublication(person.ctx, {
      source,
      revisionId,
      audience: 'draft',
      spaceId,
      parentId: null,
    }),
    attachmentIds: new Set(),
  });

const remaining = async (page: pages.PageRef) =>
  (
    await t.db
      .select({ id: schema.revisions.id })
      .from(schema.revisions)
      .where(eq(schema.revisions.pageId, page.pageId))
  ).map((r) => r.id);

/** Backdate every revision of `page`, as a page last edited long ago. */
const age = (page: pages.PageRef) =>
  t.db
    .update(schema.revisions)
    .set({ createdAt: OLD })
    .where(eq(schema.revisions.pageId, page.pageId));
const sorted = (ids: readonly string[]) => [...ids].sort();

describe('draft retention', () => {
  // What earlier tests left old goes first, so each test counts only its own.
  beforeEach(async () => {
    await sweepDrafts(t.db);
  });

  it('removes the middle of an old autosave chain while history, edits, publishing and restore still work', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const ref = await pages.uploadAttachment(alice.ctx, page, {
      name: 'kept.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('Published file'),
    });
    const second = await pages.editDraft(alice.ctx, page, {
      markdown: 'Second',
      attachments: [ref],
    });
    const published = await pages.publishPage(alice.ctx, page);
    await pages.editDraft(alice.ctx, page, { markdown: 'Third' });
    const fourth = await pages.editDraft(alice.ctx, page, { markdown: 'Fourth' });
    await age(page);
    const reader = await personWithVault(t);
    await shareFolder(alice.ctx, {
      spaceId: page.spaceId,
      rootId: null,
      people: [await invite(alice, reader, 'reader')],
    });
    const history = await pages.loadHistory(alice.ctx, page);
    const readerHistory = await pages.loadHistory(reader.ctx, page);

    expect(await sweepDrafts(t.db)).toBe(2);
    // The head, the draft the published version was made from, and that version.
    expect(sorted(await remaining(page))).toEqual(
      sorted([second.revisionId, fourth.revisionId, published.revisionId]),
    );
    expect(await pages.loadHistory(alice.ctx, page)).toEqual(history);
    expect(await pages.loadHistory(reader.ctx, page)).toEqual(readerHistory);
    expect(
      (await pages.openRevisionOf(reader.ctx, page, 'published', published.revisionId)).opened,
    ).toMatchObject({ kind: 'current', payload: { markdown: 'Second' } });
    const { heads } = await pages.loadPage(alice.ctx, page.pageId);
    expect(heads.draftHead).toBe(fourth.revisionId);
    expect(
      (await pages.openRevisionOf(alice.ctx, page, 'draft', fourth.revisionId)).opened,
    ).toMatchObject({ kind: 'current', payload: { markdown: 'Fourth' } });

    // The head's signed base is gone; editing, publishing and restoring don't need it.
    await pages.editDraft(alice.ctx, page, { markdown: 'Fifth' });
    const again = await pages.publishPage(alice.ctx, page);
    const { revisionId: restored } = await pages.restorePublished(
      alice.ctx,
      page,
      published.revisionId,
    );
    const draft = (await pages.openRevisionOf(alice.ctx, page, 'draft', restored)).opened;
    if (draft.kind !== 'current') throw new Error('expected the restored draft');
    expect(draft.payload.markdown).toBe('Second');
    const [copy] = draft.payload.attachments;
    if (!copy) throw new Error('expected the attachment');
    expect(
      new TextDecoder().decode(await pages.readAttachment(alice.ctx, page, 'draft', copy)),
    ).toBe('Published file');
    for (const person of [alice, reader]) {
      expect((await pages.loadHistory(person.ctx, page)).map((v) => v.revisionId)).toEqual(
        expect.arrayContaining([published.revisionId, again.revisionId]),
      );
    }
    // Two people, many saves, a share, a restore: slow on a busy CI runner.
  }, 90_000);

  it('keeps a checkpoint until it was saved over the retention period ago, and recent branches', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const base = await draftHead(alice, page);
    // A page idle long ago, saved over just now.
    await age(page);
    const over = await pages.editDraft(alice.ctx, page, { markdown: 'Now' });
    const old = await branch(alice, page);
    const recent = await branch(alice, page, { createdAt: new Date() });
    expect(await sweepDrafts(t.db)).toBe(1);
    expect(await remaining(page)).toEqual(expect.arrayContaining([base, recent]));
    expect(await remaining(page)).not.toContain(old);
    const saved = (days: number) =>
      t.db
        .update(schema.revisions)
        .set({ createdAt: new Date(Date.now() - days * DAY) })
        .where(eq(schema.revisions.id, over.revisionId));
    await saved(10);
    expect(await sweepDrafts(t.db)).toBe(0);
    expect(await sweepDrafts(t.db, { retentionMs: 5 * DAY })).toBe(1);
    expect(await remaining(page)).not.toContain(base);
    expect(await remaining(page)).toContain(over.revisionId);
  });

  it('answers an editor saving on a removed checkpoint with stale-head, so it offers to keep both', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    // The editor opened the draft; someone else saved over it later.
    const base = await draftHead(alice, page);
    const theirs = await pages.editDraft(alice.ctx, page, { markdown: 'Theirs' });
    const mine = newPayload({ title: 'Page', markdown: 'Mine' });
    // Kept for as long as the retention period after it was saved over.
    await t.db
      .update(schema.revisions)
      .set({ createdAt: OLD })
      .where(eq(schema.revisions.id, base));
    expect(await sweepDrafts(t.db)).toBe(0);
    await age(page);
    expect(await sweepDrafts(t.db)).toBe(1);
    expect(await remaining(page)).not.toContain(base);
    const conflict = await pages.saveDraft(alice.ctx, { page, basedOn: base, payload: mine }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toMatchObject({
      code: 'stale-head',
      detail: { draftHead: theirs.revisionId, publishedHead: null },
    });
    // Saving mine on top of theirs, as the prompt offers, goes.
    await pages.saveDraft(alice.ctx, { page, basedOn: theirs.revisionId, payload: mine });
  });

  it('keeps the source of every copy sent, even after the publication ends, and nothing else', async () => {
    const alice = await personWithVault(t);
    const source = await pageOf(alice);
    const destination = await spaces.createSpace(alice.ctx, { name: 'Copies' });
    const earlier = await branch(alice, source);
    const latest = await branch(alice, source);
    const unsent = await branch(alice, source);
    const copy = await sendCopy(alice, source, destination, earlier);
    await sendCopy(alice, source, destination, latest);
    await publications.endPublication(alice.ctx, {
      source,
      spaceId: destination,
    });
    expect(await sweepDrafts(t.db)).toBe(1);
    expect(await remaining(source)).toEqual(expect.arrayContaining([earlier, latest]));
    expect(await remaining(source)).not.toContain(unsent);
    const history = await pages.loadHistory(alice.ctx, {
      spaceId: destination,
      pageId: copy.pageId,
    });
    expect(history).toHaveLength(2);
    // The oldest copy's "Published from" label still opens its source.
    const oldest = history.at(-1);
    if (!oldest) throw new Error('expected a copy');
    const opened = await pages.openRevisionOf(
      alice.ctx,
      { spaceId: destination, pageId: copy.pageId },
      'published',
      oldest.revisionId,
    );
    if (opened.opened.kind !== 'current') throw new Error('expected the copy');
    const provenance = publications.provenanceOf(opened.opened.payload);
    if (!provenance) throw new Error('expected its provenance');
    expect(provenance.sourceRevisionId).toBe(earlier);
    expect(
      await publications.sourceTitle(alice.ctx, { provenance, copy: opened.opened.payload }),
    ).toBe('Page');
  });

  it('keeps every draft of a page whose earlier copies were sent before sources were recorded', async () => {
    const alice = await personWithVault(t);
    const source = await pageOf(alice);
    const destination = await spaces.createSpace(alice.ctx, { name: 'Legacy' });
    const earlier = await branch(alice, source);
    const latest = await branch(alice, source);
    const copy = await sendCopy(alice, source, destination, earlier);
    await sendCopy(alice, source, destination, latest);
    const unsent = await branch(alice, source);
    // As copies sent before 0015 were stored.
    await t.db
      .update(schema.revisions)
      .set({ sourceRevisionId: null })
      .where(eq(schema.revisions.pageId, copy.pageId));
    expect(await sweepDrafts(t.db)).toBe(0);
    expect(await remaining(source)).toEqual(expect.arrayContaining([earlier, latest, unsent]));
  });

  it('removes envelopes, wraps and blob references, then lets the blob sweep remove unused bytes', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const ownerPage = await pageOf(alice);
    const ownerLeaf = await branch(alice, ownerPage);
    await shareFolder(alice.ctx, { spaceId: page.spaceId, rootId: null, people: [] });
    const ref = await pages.uploadAttachment(alice.ctx, page, {
      name: 'old.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('Old attachment'),
    });
    const sharedLeaf = await branch(alice, page, {
      payload: newPayload({ title: 'Old file', markdown: '', attachments: [ref] }),
    });
    const keptRef = await pages.uploadAttachment(alice.ctx, page, {
      name: 'kept.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('Still used'),
    });
    await pages.editDraft(alice.ctx, page, { attachments: [keptRef] });
    const sharedBlobLeaf = await branch(alice, page, {
      payload: newPayload({ title: 'Same file', markdown: '', attachments: [keptRef] }),
    });
    await t.db
      .update(schema.blobs)
      .set({ createdAt: OLD })
      .where(inArray(schema.blobs.hash, [ref.blobHash, keptRef.blobHash]));
    expect(await sweepDrafts(t.db)).toBe(3);
    for (const table of [schema.revisionWraps, schema.revisionBlobs]) {
      expect(
        await t.db
          .select()
          .from(table)
          .where(inArray(table.revisionId, [ownerLeaf, sharedLeaf, sharedBlobLeaf])),
      ).toEqual([]);
    }
    expect(
      await t.db
        .select()
        .from(schema.keyEnvelopes)
        .where(inArray(schema.keyEnvelopes.subjectId, [ownerLeaf, sharedLeaf, sharedBlobLeaf])),
    ).toEqual([]);
    const store = fileBlobStore(t.blobDir);
    expect(await store.get(ref.blobHash)).not.toBeNull();
    expect((await sweepBlobs(t.db, store)).staged).toBe(1);
    expect(await store.get(ref.blobHash)).toBeNull();
    expect(await store.get(keptRef.blobHash)).not.toBeNull();
  });
});
