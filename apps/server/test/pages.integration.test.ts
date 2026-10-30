import {
  generateIdentity,
  IdentityId,
  newId,
  newPayload,
  pageOperations as pages,
  PageId,
  PageTooLarge,
  RevisionId,
  sealRevisionV2,
  sharingOperations as sharing,
  spaceOperations,
  type ClientContext,
  type KeyTarget,
  type PagePayload,
  type PrivateIdentity,
} from '@wikistow/client';
import { directoryEntry, MARKERS, writeTargetOf } from '@wikistow/client/testing';
import { pageRoutes, structureRoutes, type Audience, type SpaceId } from '@wikistow/contracts';
import {
  fileBlobStore,
  REVISION_BATCH_BYTES,
  schema,
  sweepBlobs,
  usedBytes,
} from '@wikistow/server';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, scratchApps, type TestApp } from './support/harness.ts';
import { invite, shareFolder } from './support/sharing.ts';

let t: TestApp;
const scratchApp = scratchApps();
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

type Person = Awaited<ReturnType<typeof personWithVault>>;
type PageRef = pages.PageRef;

/** A person's own space with one page in it. */
async function pageOf(person: Person, markdown: string = MARKERS.publishedBody) {
  const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Notes' });
  const pageId = await pages.createPage(person.ctx, {
    spaceId,
    parentId: null,
    title: MARKERS.title,
    markdown,
  });
  return { spaceId, pageId };
}

/**
 * Share the space with `other` through the owner's own actions: make it a
 * share the first time, and add them to it after that.
 */
async function share(
  owner: Person,
  other: Person,
  spaceId: SpaceId,
  role: 'reader' | 'editor',
  canPublish = false,
) {
  const person = await sharing.findPerson(owner.ctx, other.email);
  if (!person) throw new Error('expected to find them');
  const [existing] = await sharing.listShares(owner.ctx, spaceId);
  if (existing) {
    await sharing.addMember(owner.ctx, {
      spaceId,
      shareId: existing.shareId,
      person,
      role,
      canPublish,
    });
  } else {
    await shareFolder(owner.ctx, {
      spaceId,
      rootId: null,
      people: [{ person, role, canPublish }],
    });
  }
}

async function draftHead(person: Person, page: PageRef) {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  if (!heads.draftHead) throw new Error('expected a draft');
  return heads.draftHead;
}

async function payloadOf(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  revisionId: RevisionId,
) {
  const { opened } = await pages.openRevisionOf(ctx, page, audience, revisionId);
  if (opened.kind !== 'current') throw new Error('expected the current format');
  return opened.payload;
}

/** A hand-made draft commit, so a test can break exactly one thing. */
async function draftCommit(
  person: Person,
  page: PageRef,
  {
    basedOn,
    payload = newPayload({ title: 'x', markdown: 'y' }),
    author = person.ctx.identity,
    target = page,
    recipients = 'all',
    newPage = false,
  }: {
    basedOn: RevisionId | null;
    payload?: PagePayload;
    author?: PrivateIdentity;
    target?: PageRef;
    recipients?: 'all' | 'none';
    /** Key it as a new page at the space root, which doesn't exist yet. */
    newPage?: boolean;
  },
) {
  const { permissionVersion, keyTarget: to } = await writeTargetOf(
    person.ctx,
    page.spaceId,
    newPage ? null : page.pageId,
  );
  const keyTarget: KeyTarget = recipients === 'none' && to.recipients ? { recipients: [] } : to;
  const sealed = sealRevisionV2({
    author,
    target: {
      installationId: person.ctx.installationId,
      ...target,
      revisionId: newId(RevisionId),
      audience: 'draft',
      basedOn,
    },
    payload,
    ...keyTarget,
  });
  return {
    ...sealed,
    blobRefs: payload.attachments.map((ref) => ref.blobHash),
    permissionVersion,
    restoredFrom: null,
  };
}

const save = (person: Person, page: PageRef, body: z.input<typeof pageRoutes.saveDraft.body>) =>
  rejection(person.api.call(pageRoutes.saveDraft, { params: { pageId: page.pageId }, body }));

describe('a page, end to end over HTTP', () => {
  it('drafts with an attachment, publishes, edits privately, and restores', async () => {
    const alice = await personWithVault(t);
    const carol = await personWithVault(t);
    const page = await pageOf(alice);
    await share(alice, carol, page.spaceId, 'reader');

    const photo = await pages.uploadAttachment(alice.ctx, page, {
      name: MARKERS.attachmentName,
      mediaType: 'image/jpeg',
      bytes: bytes(MARKERS.attachmentBody),
    });
    await pages.editDraft(alice.ctx, page, { attachments: [photo] });
    const { revisionId: published } = await pages.publishPage(alice.ctx, page);
    expect((await pages.loadPage(alice.ctx, page.pageId)).heads).toMatchObject({
      publishedHead: published,
      publishedCount: 1,
      draftChanges: false,
    });

    // The reader sees the publication and its attachment, and nothing else.
    const forCarol = await pages.loadPage(carol.ctx, page.pageId);
    expect(forCarol.heads).toMatchObject({ draftHead: null, publishedHead: published });
    const seen = await payloadOf(carol.ctx, page, 'published', published);
    expect(seen).toMatchObject({ title: MARKERS.title, markdown: MARKERS.publishedBody });
    const [shared] = seen.attachments;
    if (!shared) throw new Error('expected the attachment');
    expect(shared.blobHash).not.toBe(photo.blobHash);
    expect(text(await pages.readAttachment(carol.ctx, page, 'published', shared))).toBe(
      MARKERS.attachmentBody,
    );
    expect(await rejection(pages.readAttachment(carol.ctx, page, 'draft', photo))).toBe(
      'not-found',
    );

    // A private edit changes the draft only.
    await pages.editDraft(alice.ctx, page, { markdown: MARKERS.privateBody });
    const { heads } = await pages.loadPage(alice.ctx, page.pageId);
    expect(heads.draftChanges).toBe(true);
    if (!heads.draftHead) throw new Error('expected a draft');
    expect((await pages.openRevisions(carol.ctx, page, 'draft', [heads.draftHead])).size).toBe(0);
    expect((await payloadOf(carol.ctx, page, 'published', published)).markdown).toBe(
      MARKERS.publishedBody,
    );

    // Restoring makes the publication the draft again, with its own attachment copy.
    const { revisionId: restored } = await pages.restorePublished(alice.ctx, page, published);
    const draft = await payloadOf(alice.ctx, page, 'draft', restored);
    expect(draft.markdown).toBe(MARKERS.publishedBody);
    const [copy] = draft.attachments;
    if (!copy) throw new Error('expected the attachment');
    expect(copy.blobHash).not.toBe(shared.blobHash);
    expect(text(await pages.readAttachment(alice.ctx, page, 'draft', copy))).toBe(
      MARKERS.attachmentBody,
    );
    const { revisions } = await alice.api.call(pageRoutes.fetchRevisions, {
      body: { ids: [restored] },
    });
    expect(revisions[0]?.meta.restoredFrom).toBe(published);

    const { revisionId: second } = await pages.publishPage(alice.ctx, page);
    const history = await pages.loadHistory(carol.ctx, page);
    expect(history.map((v) => [v.revisionId, v.publishedSeq])).toEqual([
      [second, 2],
      [published, 1],
    ]);
    expect(history[0]?.publisher.identityId).toBe(alice.vault.identity.public.id);
  });

  it('shows titles in the tree: drafts for editors, publications for readers', async () => {
    const alice = await personWithVault(t);
    const carol = await personWithVault(t);
    const page = await pageOf(alice);
    await share(alice, carol, page.spaceId, 'reader');
    const unpublished = await pages.createPage(alice.ctx, {
      spaceId: page.spaceId,
      parentId: null,
      title: 'Not yet',
    });
    await pages.publishPage(alice.ctx, page);
    await pages.editDraft(alice.ctx, page, { title: 'Renamed in the draft' });

    const titles = async (person: Person) =>
      Object.fromEntries(
        (await spaceOperations.loadTree(person.ctx, page.spaceId)).pages.map((p) => [
          p.id,
          p.title,
        ]),
      );
    expect(await titles(alice)).toEqual({
      [page.pageId]: 'Renamed in the draft',
      [unpublished]: 'Not yet',
    });
    expect(await titles(carol)).toEqual({ [page.pageId]: MARKERS.title });
  });
});

const blobBytes = (hash: string) => readFile(`${t.blobDir}/objects/${hash.slice(0, 2)}/${hash}`);

describe('page commits are checked on the server', () => {
  it('refusing wrong bindings, authors, bases, permissions, and keys', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const other = await pages.createPage(alice.ctx, {
      spaceId: page.spaceId,
      parentId: null,
      title: 'Other',
    });
    const head = await draftHead(alice, page);

    const misbound = await draftCommit(alice, page, {
      basedOn: head,
      target: { ...page, pageId: other },
    });
    expect(await save(alice, page, misbound)).toBe('binding-mismatch');

    const impostor = generateIdentity({ kind: 'human', id: newId(IdentityId) });
    alice.ctx.trust.use(directoryEntry(impostor.public));
    expect(
      await save(alice, page, await draftCommit(alice, page, { basedOn: head, author: impostor })),
    ).toBe('forbidden');

    expect(await save(alice, page, await draftCommit(alice, page, { basedOn: null }))).toBe(
      'stale-head',
    );

    const fine = await draftCommit(alice, page, { basedOn: head });
    expect(await save(alice, page, { ...fine, permissionVersion: 2 })).toBe('permission-version');

    expect(
      await save(
        alice,
        page,
        await draftCommit(alice, page, { basedOn: head, recipients: 'none' }),
      ),
    ).toBe('recipients-mismatch');

    expect(await draftHead(alice, page)).toBe(head);
    expect(await save(alice, page, fine)).toBe('no error');
  });

  it('refusing a version larger than a page may hold, before or after the client checks', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const head = await draftHead(alice, page);
    // Plain ASCII, so JSON writes the Markdown byte for byte.
    const sized = (bytes: number) => {
      const empty = JSON.stringify(newPayload({ title: 'x', markdown: '' })).length;
      return newPayload({ title: 'x', markdown: 'a'.repeat(bytes - empty) });
    };

    // The app refuses it before sending anything.
    const long = newPayload({
      title: 'x',
      markdown: 'a'.repeat(pageRoutes.MAX_MARKDOWN_BYTES + 1),
    });
    await expect(
      pages.saveDraft(alice.ctx, { page, basedOn: head, payload: long }),
    ).rejects.toThrow(PageTooLarge);
    expect(await draftHead(alice, page)).toBe(head);

    // A client that skips the check: the server counts the ciphertext.
    const over = await draftCommit(alice, page, {
      basedOn: head,
      payload: sized(pageRoutes.MAX_PAYLOAD_BYTES + 1),
    });
    expect(over.revision.payload.ciphertext.length).toBeGreaterThan(
      pageRoutes.MAX_PAYLOAD_CIPHERTEXT,
    );
    expect(await save(alice, page, over)).toBe('payload-too-large');
    const most = await draftCommit(alice, page, {
      basedOn: head,
      payload: sized(pageRoutes.MAX_PAYLOAD_BYTES),
    });
    expect(most.revision.payload.ciphertext.length).toBe(pageRoutes.MAX_PAYLOAD_CIPHERTEXT);
    expect(await save(alice, page, most)).toBe('no error');
  });

  it('replaying an identical save or new page', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const head = await draftHead(alice, page);
    const commit = await draftCommit(alice, page, { basedOn: head });
    const send = () =>
      alice.api.call(pageRoutes.saveDraft, { params: { pageId: page.pageId }, body: commit });
    expect(await send()).toMatchObject({ replayed: false });
    expect(await send()).toMatchObject({ replayed: true });

    const pageId = newId(PageId);
    const created = await draftCommit(
      alice,
      { spaceId: page.spaceId, pageId },
      { basedOn: null, newPage: true },
    );
    const create = () =>
      alice.api.call(pageRoutes.createPage, {
        params: { spaceId: page.spaceId },
        body: { ...created, pageId, parentId: null },
      });
    expect(await create()).toMatchObject({ pageId });
    expect(await create()).toMatchObject({ pageId });
  });

  it('letting exactly one of two concurrent saves or publications win', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const head = await draftHead(alice, page);
    const [a, b] = await Promise.all([
      draftCommit(alice, page, { basedOn: head }),
      draftCommit(alice, page, { basedOn: head }),
    ]);
    const saves = await Promise.all([save(alice, page, a), save(alice, page, b)]);
    expect(saves.sort()).toEqual(['no error', 'stale-head']);

    const publications = await Promise.all([
      rejection(pages.publishPage(alice.ctx, page)),
      rejection(pages.publishPage(alice.ctx, page)),
    ]);
    expect(publications.sort()).toEqual(['no error', 'stale-head']);
    expect((await pages.loadPage(alice.ctx, page.pageId)).heads.publishedCount).toBe(1);
  });

  it('requiring every attachment to be uploaded for this page and audience', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const elsewhere = await pageOf(alice);
    const file = { name: 'a.txt', mediaType: 'text/plain', bytes: bytes('hello') };
    const head = await draftHead(alice, page);
    const withAttachment = async (ref: Awaited<ReturnType<typeof pages.uploadAttachment>>) =>
      save(
        alice,
        page,
        await draftCommit(alice, page, {
          basedOn: head,
          payload: newPayload({ title: 'x', markdown: 'y', attachments: [ref] }),
        }),
      );

    const notUploaded = await pages.uploadAttachment(alice.ctx, elsewhere, file);
    expect(await withAttachment(notUploaded)).toBe('missing-blob');

    // The same encrypted bytes can't be relabelled as another page's.
    const ownBlob = (await t.db.select().from(schema.blobs)).find(
      (b) => b.hash === notUploaded.blobHash,
    );
    expect(ownBlob?.pageId).toBe(elsewhere.pageId);
    const relabel = await alice.browser.fetch(`/api/pages/${page.pageId}/blobs?audience=draft`, {
      method: 'PUT',
      body: await blobBytes(notUploaded.blobHash),
    });
    expect(((await relabel.json()) as { error: { code: string } }).error.code).toBe(
      'blob-label-mismatch',
    );

    const uploaded = await pages.uploadAttachment(alice.ctx, page, file);
    expect(await withAttachment(uploaded)).toBe('no error');
  });
});

// Change a stored row past the trigger that keeps it immutable.
async function tamper(table: 'revisions' | 'metadata_revisions', change: () => Promise<unknown>) {
  const trigger = sql.raw(`${table}_immutable`);
  await t.db.execute(sql`alter table ${sql.raw(table)} disable trigger ${trigger}`);
  try {
    await change();
  } finally {
    await t.db.execute(sql`alter table ${sql.raw(table)} enable trigger ${trigger}`);
  }
}

describe('a property set in a draft, as a folder table’s cell sets it', () => {
  // An Obsidian note's block, with comments and quoting of its own.
  const NOTE =
    '---\r\n# From Obsidian\r\nservings: 4 # people\r\ntags: [soup, "winter"]\r\n---\r\nSimmer.';

  async function opened(person: Person, page: PageRef, revisionId: RevisionId) {
    const revision = await pages.openRevisionOf(person.ctx, page, 'draft', revisionId);
    if (revision.opened.kind !== 'current') throw new Error('expected a current payload');
    return revision.opened.payload.markdown;
  }

  it('changes only that value’s characters, against the version it read, and refuses on a conflict', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice, NOTE);
    const read = await draftHead(alice, page);

    const set = await pages.setDraftProperty(alice.ctx, {
      page,
      basedOn: read,
      key: 'servings',
      value: 6,
    });
    if (!set.ok || !set.written) throw new Error('expected a write');
    expect(await opened(alice, page, set.written.revisionId)).toBe(NOTE.replace('4 #', '6 #'));
    expect(await draftHead(alice, page)).toBe(set.written.revisionId);

    // Another edit made from the version read first finds the draft moved on.
    expect(
      await rejection(
        pages.setDraftProperty(alice.ctx, { page, basedOn: read, key: 'servings', value: 8 }),
      ),
    ).toBe('stale-head');
    expect(await draftHead(alice, page)).toBe(set.written.revisionId);

    // A key the page hasn't is a line at the block's end, in its line breaks.
    const added = await pages.setDraftProperty(alice.ctx, {
      page,
      basedOn: set.written.revisionId,
      key: 'cook_time',
      value: 40,
    });
    if (!added.ok || !added.written) throw new Error('expected a write');
    expect(await opened(alice, page, added.written.revisionId)).toBe(
      NOTE.replace('4 #', '6 #').replace('"winter"]\r\n', '"winter"]\r\ncook_time: 40\r\n'),
    );
  });

  it('gives a page without frontmatter a block, writes nothing for no change, and refuses what can’t change in place', async () => {
    const alice = await personWithVault(t);
    const plain = await pageOf(alice, 'Just text.');
    const set = await pages.setDraftProperty(alice.ctx, {
      page: plain,
      basedOn: await draftHead(alice, plain),
      key: 'status',
      value: 'draft',
    });
    if (!set.ok || !set.written) throw new Error('expected a write');
    expect(await opened(alice, plain, set.written.revisionId)).toBe(
      '---\nstatus: draft\n---\nJust text.',
    );
    expect(
      await pages.setDraftProperty(alice.ctx, {
        page: plain,
        basedOn: set.written.revisionId,
        key: 'status',
        value: 'draft',
      }),
    ).toEqual({ ok: true, written: null });

    const folded = await pageOf(alice, '---\nnotes: |\n  Two\n  lines.\n---\n');
    const head = await draftHead(alice, folded);
    expect(
      await pages.setDraftProperty(alice.ctx, {
        page: folded,
        basedOn: head,
        key: 'notes',
        value: 'one line',
      }),
    ).toMatchObject({ ok: false });
    expect(await draftHead(alice, folded)).toBe(head);
  });
});

describe('stored revisions', () => {
  it('that today’s schemas refuse are left out of listings and logged, never failing them', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const { revisionId: first } = await pages.publishPage(alice.ctx, page);
    const { revisionId: second } = await pages.publishPage(alice.ctx, page);
    const other = await pageOf(alice);
    const otherHead = await draftHead(alice, other);
    // An extra member, as a looser older schema might have let through.
    const loosen = (sealed: unknown) => {
      const { record, ...rest } = z.looseObject({ record: z.looseObject({}) }).parse(sealed);
      return { ...rest, record: { ...record, note: 'stored before Milestone 2' } };
    };
    const [revision] = await t.db
      .select({ sealed: schema.revisions.sealed })
      .from(schema.revisions)
      .where(eq(schema.revisions.id, first));
    await tamper('revisions', () =>
      t.db
        .update(schema.revisions)
        .set({ sealed: loosen(revision?.sealed) })
        .where(eq(schema.revisions.id, first)),
    );
    const [space] = await t.db
      .select({ head: schema.spaces.metadataHead })
      .from(schema.spaces)
      .where(eq(schema.spaces.id, other.spaceId));
    const spaceHead = space?.head ?? '';
    const [metadata] = await t.db
      .select({ sealed: schema.metadataRevisions.sealed })
      .from(schema.metadataRevisions)
      .where(eq(schema.metadataRevisions.id, spaceHead));
    await tamper('metadata_revisions', () =>
      t.db
        .update(schema.metadataRevisions)
        .set({ sealed: loosen(metadata?.sealed) })
        .where(eq(schema.metadataRevisions.id, spaceHead)),
    );

    const { versions } = await alice.api.call(pageRoutes.history, {
      params: { pageId: page.pageId },
    });
    expect(versions.map((v) => v.revisionId)).toEqual([second]);
    const batch = await alice.api.call(pageRoutes.fetchRevisions, {
      body: { ids: [first, otherHead] },
    });
    expect(batch.revisions.map((r) => r.revision.record.revisionId)).toEqual([otherHead]);
    const { spaces } = await alice.api.call(structureRoutes.listSpaces);
    expect(spaces.map((s) => s.id)).toEqual([page.spaceId]);

    const logged = t.logs.filter((entry) => entry.event === 'unreadable-row');
    expect(logged).toContainEqual({
      level: 'warn',
      event: 'unreadable-row',
      table: 'revisions',
      rowId: first,
    });
    expect(logged).toContainEqual({
      level: 'warn',
      event: 'unreadable-row',
      table: 'metadata_revisions',
      rowId: spaceHead,
    });
    expect(JSON.stringify(t.logs)).not.toContain('stored before Milestone 2');
  });
});

describe('roles', () => {
  it('let editors draft, and hide drafts from someone made a reader', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const page = await pageOf(alice);
    await share(alice, bob, page.spaceId, 'editor');
    // Bob is a draft recipient from here on.
    const { revisionId: draft } = await pages.editDraft(alice.ctx, page, {
      markdown: MARKERS.privateBody,
    });
    expect((await payloadOf(bob.ctx, page, 'draft', draft)).markdown).toBe(MARKERS.privateBody);
    await pages.editDraft(bob.ctx, page, { title: 'Edited by an editor' });

    // Made a reader, Bob keeps the draft keys he had but is no longer sent drafts.
    const [shared] = await sharing.listShares(alice.ctx, page.spaceId);
    if (!shared) throw new Error('expected the share');
    await sharing.demoteMember(alice.ctx, {
      spaceId: page.spaceId,
      shareId: shared.shareId,
      identityId: bob.vault.identity.public.id,
    });
    expect((await pages.openRevisions(bob.ctx, page, 'draft', [draft], { fresh: true })).size).toBe(
      0,
    );
    expect(await rejection(pages.editDraft(bob.ctx, page, { title: 'Again' }))).toBe('not-found');
  });
});

describe('readers', () => {
  it('can’t find or draft into pages that were never published, nor add one', async () => {
    const alice = await personWithVault(t);
    const carol = await personWithVault(t);
    const page = await pageOf(alice);
    await share(alice, carol, page.spaceId, 'reader');
    const head = await draftHead(alice, page);
    const code = (promise: Promise<unknown>) => rejection(promise);
    expect(await code(pages.loadPage(carol.ctx, page.pageId))).toBe('not-found');
    expect(await code(pages.loadHistory(carol.ctx, page))).toBe('not-found');
    expect(await save(carol, page, await draftCommit(alice, page, { basedOn: head }))).toBe(
      'not-found',
    );
    // Straight to the server, which refuses a reader's new page.
    const pageId = newId(PageId);
    const commit = await draftCommit(
      alice,
      { spaceId: page.spaceId, pageId },
      { basedOn: null, newPage: true },
    );
    expect(
      await code(
        carol.api.call(pageRoutes.createPage, {
          params: { spaceId: page.spaceId },
          body: { ...commit, pageId, parentId: null },
        }),
      ),
    ).toBe('forbidden');
  });
});

// A page's Markdown close to the largest payload a version may hold: JSON
// writes each line break in two bytes.
const BIG = '\n'.repeat(240_000);

describe('fetching revisions', () => {
  it('answers in parts that the client asks for again', async () => {
    const alice = await personWithVault(t);
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Long reads' });
    // Each version close to the largest a page may hold.
    const titles = ['One', 'Two', 'Three', 'Four'];
    const ids: RevisionId[] = [];
    for (const title of titles) {
      const pageId = await pages.createPage(alice.ctx, {
        spaceId,
        parentId: null,
        title,
        markdown: BIG,
      });
      ids.push(await draftHead(alice, { spaceId, pageId }));
    }

    // Asked newest first, so the order of the answer can't be the order stored.
    const asked = [...ids].reverse();
    const res = await alice.browser.request('/api/revisions/batch', {
      method: 'POST',
      json: { ids: asked },
    });
    const body = await res.text();
    const answer = pageRoutes.fetchRevisions.response.parse(JSON.parse(body));
    expect(answer.revisions.length).toBeGreaterThan(0);
    // The first ones asked for are the ones sent.
    expect([
      ...answer.revisions.map((r) => r.revision.record.revisionId),
      ...answer.deferred,
    ]).toEqual(asked);
    expect(answer.deferred.length).toBeGreaterThan(0);
    expect(answer.revisions.length + answer.deferred.length).toBe(titles.length);
    expect(body.length).toBeLessThan(REVISION_BATCH_BYTES + 64 * 1024);

    const tree = await spaceOperations.loadTree(alice.ctx, spaceId);
    expect(new Set(tree.pages.map((p) => p.title))).toEqual(new Set(titles));
  });
});

describe('attachment uploads', () => {
  /** An account in a small installation, with exactly `room` bytes of storage left. */
  async function nearlyFull(room: number) {
    const storageBytes = 100_000;
    const small = await scratchApp({ limits: { uploadBytes: 64, storageBytes } });
    const alice = await personWithVault(small);
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Small' });
    const pageId = await pages.createPage(alice.ctx, { spaceId, parentId: null, title: 'P' });
    const used = await usedBytes(small.db, alice.id);
    // Someone else's attachment can't count, so this one is alice's own.
    await small.db.insert(schema.blobs).values({
      hash: 'x'.repeat(43),
      spaceId,
      pageId,
      audience: 'draft',
      size: storageBytes - used - room,
      uploadedBy: alice.id,
    });
    const upload = (size: number) =>
      rejection(
        alice.api.upload(
          `/api/pages/${pageId}/blobs?audience=draft`,
          crypto.getRandomValues(new Uint8Array(size)),
          pageRoutes.BlobUploadResult,
        ),
      );
    return { small, upload };
  }

  it('stop at the size limit and the account’s storage quota, leaving nothing behind', async () => {
    const { small, upload } = await nearlyFull(100);
    expect(await upload(65)).toBe('payload-too-large');
    expect(await upload(60)).toBe('no error');
    expect(await upload(60)).toBe('storage-full');
    expect(await upload(40)).toBe('no error');
    const files = await readdir(small.blobDir, { recursive: true, withFileTypes: true });
    expect(files.filter((f) => f.isFile()).map((f) => f.parentPath.endsWith('staging'))).toEqual([
      false,
      false,
    ]);
  });
});

describe('the attachment sweep', () => {
  it('removes old unlisted uploads, files without rows, and stale staging', async () => {
    const own = await scratchApp();
    const store = fileBlobStore(own.blobDir);
    const alice = await personWithVault(own);
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Sweep' });
    const pageId = await pages.createPage(alice.ctx, { spaceId, parentId: null, title: 'P' });
    const page = { spaceId, pageId };
    const file = (name: string) => ({ name, mediaType: 'text/plain', bytes: bytes(name) });
    const kept = await pages.uploadAttachment(alice.ctx, page, file('kept'));
    await pages.editDraft(alice.ctx, page, { attachments: [kept] });
    const unlisted = await pages.uploadAttachment(alice.ctx, page, file('unlisted'));
    const recent = await pages.uploadAttachment(alice.ctx, page, file('recent'));

    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await own.db
      .update(schema.blobs)
      .set({ createdAt: old })
      .where(sql`${schema.blobs.hash} in (${kept.blobHash}, ${unlisted.blobHash})`);
    const orphan = 'o'.repeat(43);
    await mkdir(join(own.blobDir, 'objects', 'oo'), { recursive: true });
    await writeFile(join(own.blobDir, 'objects', 'oo', orphan), 'no row');
    // Written just now, perhaps by an upload about to insert its row.
    const fresh = 'f'.repeat(43);
    await mkdir(join(own.blobDir, 'objects', 'ff'), { recursive: true });
    await writeFile(join(own.blobDir, 'objects', 'ff', fresh), 'row on its way');
    await mkdir(join(own.blobDir, 'staging'), { recursive: true });
    await writeFile(join(own.blobDir, 'staging', 'left.tmp'), 'interrupted');
    for (const path of [
      join(own.blobDir, 'objects', 'oo', orphan),
      join(own.blobDir, 'staging', 'left.tmp'),
      join(own.blobDir, 'objects', kept.blobHash.slice(0, 2), kept.blobHash),
    ]) {
      await utimes(path, old, old);
    }

    expect(await sweepBlobs(own.db, store)).toEqual({
      staged: 1,
      openings: 0,
      copies: 0,
      copiesFailed: 0,
    });
    const rows = (await own.db.select().from(schema.blobs)).map((b) => b.hash).sort();
    expect(rows).toEqual([kept.blobHash, recent.blobHash].sort());
    expect(await store.get(unlisted.blobHash)).toBeNull();
    expect(await store.get(orphan)).toBeNull();
    expect(await store.get(fresh)).not.toBeNull();
    expect(await store.get(kept.blobHash)).not.toBeNull();
    expect(await readdir(join(own.blobDir, 'staging'))).toEqual([]);
  });
});

describe('deleting', () => {
  it('only removes nodes from the space it names', async () => {
    const alice = await personWithVault(t);
    const page = await pageOf(alice);
    const { spaceId: otherSpace } = await pageOf(alice);
    expect(
      await rejection(pages.deleteNode(alice.ctx, { spaceId: otherSpace, nodeId: page.pageId })),
    ).toBe('not-found');
    expect((await pages.loadPage(alice.ctx, page.pageId)).pageId).toBe(page.pageId);
  });

  it('removes a folder with its pages, keys, metadata, and blob files', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Space' });
    const folderId = await spaceOperations.createFolder(alice.ctx, {
      spaceId,
      parentId: null,
      name: 'Old',
    });
    const pageId = await pages.createPage(alice.ctx, { spaceId, parentId: folderId, title: 'P' });
    const page = { spaceId, pageId };
    const ref = await pages.uploadAttachment(alice.ctx, page, {
      name: 'f',
      mediaType: 'text/plain',
      bytes: bytes('file'),
    });
    await pages.editDraft(alice.ctx, page, { attachments: [ref] });
    await pages.publishPage(alice.ctx, page);
    await share(alice, bob, spaceId, 'editor');

    const revisionIds = (
      await t.db
        .select({ id: schema.revisions.id })
        .from(schema.revisions)
        .where(eq(schema.revisions.pageId, pageId))
    ).map((r) => r.id);
    const folderMetadataIds = (
      await t.db
        .select({ id: schema.metadataRevisions.id })
        .from(schema.metadataRevisions)
        .where(eq(schema.metadataRevisions.subjectId, folderId))
    ).map((m) => m.id);
    expect(revisionIds.length).toBeGreaterThan(0);
    expect(folderMetadataIds.length).toBeGreaterThan(0);

    const remove = (person: Person) =>
      rejection(pages.deleteNode(person.ctx, { spaceId, nodeId: folderId }));
    expect(await remove(bob)).toBe('forbidden');
    expect(await remove(alice)).toBe('no error');

    const rows = async (query: ReturnType<typeof sql>) => [...(await t.db.execute(query))].length;
    expect(await rows(sql`select 1 from nodes where space_id = ${spaceId}`)).toBe(0);
    expect(await rows(sql`select 1 from revisions where space_id = ${spaceId}`)).toBe(0);
    expect(await rows(sql`select 1 from page_heads where page_id = ${pageId}`)).toBe(0);
    expect(await rows(sql`select 1 from blobs where space_id = ${spaceId}`)).toBe(0);
    expect(await rows(sql`select 1 from metadata_revisions where subject_id = ${folderId}`)).toBe(
      0,
    );
    const subjects = [...revisionIds, ...folderMetadataIds];
    expect(
      (await t.db.select().from(schema.keyEnvelopes)).filter((e) => subjects.includes(e.subjectId)),
    ).toEqual([]);
    const files = await readdir(`${t.blobDir}/objects`, { recursive: true, withFileTypes: true });
    expect(files.filter((f) => f.isFile() && f.name === ref.blobHash)).toEqual([]);
  });

  it('removes a whole space for its owners, but never a home space', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const home = await spaceOperations.createSpace(alice.ctx, { name: 'Home' });
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Space' });
    // The page stays sealed to the owners, the folder is shared with Bob.
    const page = {
      spaceId,
      pageId: await pages.createPage(alice.ctx, { spaceId, parentId: null, title: 'P' }),
    };
    const ref = await pages.uploadAttachment(alice.ctx, page, {
      name: 'f',
      mediaType: 'text/plain',
      bytes: bytes('whole space'),
    });
    await pages.editDraft(alice.ctx, page, { attachments: [ref] });
    await pages.publishPage(alice.ctx, page);
    const folderId = await spaceOperations.createFolder(alice.ctx, {
      spaceId,
      parentId: null,
      name: 'Shared',
    });
    await shareFolder(alice.ctx, {
      spaceId,
      rootId: folderId,
      people: [await invite(alice, bob, 'editor')],
    });
    await t.db
      .update(schema.users)
      .set({ spaceOrder: [spaceId] })
      .where(eq(schema.users.id, bob.id));
    const subjects = [
      ...(await t.db
        .select({ id: schema.revisions.id })
        .from(schema.revisions)
        .where(eq(schema.revisions.spaceId, spaceId))),
      ...(await t.db
        .select({ id: schema.metadataRevisions.id })
        .from(schema.metadataRevisions)
        .where(eq(schema.metadataRevisions.spaceId, spaceId))),
    ].map((row) => row.id);
    const envelopes = async () =>
      (await t.db.select().from(schema.keyEnvelopes)).filter((e) => subjects.includes(e.subjectId));
    expect((await envelopes()).length).toBeGreaterThan(0);

    const version = async (id: SpaceId) => {
      const [space] = await t.db
        .select({ permissionVersion: schema.spaces.permissionVersion })
        .from(schema.spaces)
        .where(eq(schema.spaces.id, id));
      return space?.permissionVersion ?? 1;
    };
    const remove = async (person: Person, id: SpaceId, seen?: number) =>
      rejection(
        spaceOperations.deleteSpace(person.ctx, {
          spaceId: id,
          permissionVersion: seen ?? (await version(id)),
        }),
      );
    expect(await remove(bob, spaceId)).toBe('forbidden');
    expect(await remove(alice, home)).toBe('home-space');
    // Shown who had access before Bob was given the folder.
    expect(await remove(alice, spaceId, (await version(spaceId)) - 1)).toBe('permission-version');
    expect(await remove(alice, spaceId)).toBe('no error');
    expect(await remove(alice, spaceId)).toBe('not-found');

    const rows = async (query: ReturnType<typeof sql>) => [...(await t.db.execute(query))].length;
    for (const table of ['spaces', 'nodes', 'revisions', 'blobs', 'metadata_revisions', 'shares']) {
      const column = table === 'spaces' ? 'id' : 'space_id';
      expect(
        await rows(
          sql`select 1 from ${sql.identifier(table)} where ${sql.identifier(column)} = ${spaceId}`,
        ),
        table,
      ).toBe(0);
    }
    expect(await envelopes()).toEqual([]);
    const files = await readdir(`${t.blobDir}/objects`, { recursive: true, withFileTypes: true });
    expect(files.filter((f) => f.isFile() && f.name === ref.blobHash)).toEqual([]);
    const [order] = await t.db
      .select({ spaceOrder: schema.users.spaceOrder })
      .from(schema.users)
      .where(eq(schema.users.id, bob.id));
    expect(order?.spaceOrder).toEqual([]);
    expect((await spaceOperations.loadSpaces(alice.ctx)).map((s) => s.id)).toEqual([home]);
  });
});
