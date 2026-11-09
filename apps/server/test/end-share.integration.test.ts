// Ending a share (protocol section 6.9, ADR 0012): the server's checks and
// transaction, driven by an owner's app as the client operation will be.
import {
  ApiError,
  ENDED,
  endingOperations as ending,
  moveOperations as moves,
  newId,
  newPayload,
  pageOperations as pages,
  publicationOperations as pubs,
  publicLinkOperations as links,
  spaceOperations,
  RevisionId,
  sealRevisionV2,
  trashOperations as trash,
  type FolderId,
  type PageId,
  type ShareId,
  type SpaceId,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import { pageRoutes, sharingRoutes } from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { addToGroup, makeGroup, shareWithGroup } from './support/groups.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import {
  draftHead,
  invite,
  library,
  lyingServer,
  SPACE,
  sealEnding,
  shareFolder,
  tampering,
  type Person,
} from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

type Ending = { spaceId: SpaceId; shareId: ShareId; rootId: FolderId | null };

/** The permission version an ending carries: its root's, or the space's for a space share. */
async function rootVersion(spaceId: SpaceId, rootId: FolderId | null) {
  const [row] =
    rootId === null
      ? await t.db
          .select({ version: schema.spaces.permissionVersion })
          .from(schema.spaces)
          .where(eq(schema.spaces.id, spaceId))
      : await t.db
          .select({ version: schema.nodes.permissionVersion })
          .from(schema.nodes)
          .where(eq(schema.nodes.id, rootId));
  if (!row) throw new Error('expected the root');
  return row.version;
}

/** End a share as the owner's app does: scan, seal to the owners, send. */
async function endShare(owner: Person, { spaceId, shareId, rootId }: Ending, ctx = owner.ctx) {
  const body = {
    permissionVersion: await rootVersion(spaceId, rootId),
    ...(await sealEnding(ctx, { spaceId, shareId })),
  };
  return ctx.api.call(sharingRoutes.endShare, { params: { shareId }, body });
}

/** What is left of a share in every table that hangs off it. */
async function leftOf(shareId: ShareId) {
  const rows = await Promise.all([
    t.db.select().from(schema.shares).where(eq(schema.shares.id, shareId)),
    t.db.select().from(schema.shareMembers).where(eq(schema.shareMembers.shareId, shareId)),
    t.db.select().from(schema.shareGroups).where(eq(schema.shareGroups.shareId, shareId)),
    t.db.select().from(schema.agentGrants).where(eq(schema.agentGrants.shareId, shareId)),
    t.db
      .select()
      .from(schema.folderKeyEnvelopes)
      .where(eq(schema.folderKeyEnvelopes.shareId, shareId)),
    t.db.select().from(schema.revisionWraps).where(eq(schema.revisionWraps.shareId, shareId)),
    t.db.select().from(schema.metadataWraps).where(eq(schema.metadataWraps.shareId, shareId)),
  ]);
  return rows.map((found) => found.length);
}

/** Each version of a page, with whom its envelopes go to and the share its wrap names. */
async function keysOfPage(pageId: string) {
  const revisions = await t.db
    .select({ id: schema.revisions.id, shareId: schema.revisionWraps.shareId })
    .from(schema.revisions)
    .leftJoin(schema.revisionWraps, eq(schema.revisionWraps.revisionId, schema.revisions.id))
    .where(eq(schema.revisions.pageId, pageId));
  const envelopes = await t.db
    .select({
      id: schema.keyEnvelopes.subjectId,
      to: schema.keyEnvelopes.recipientIdentityId,
    })
    .from(schema.keyEnvelopes)
    .where(eq(schema.keyEnvelopes.subjectKind, 'revision'));
  return revisions.map((revision) => ({
    shareId: revision.shareId,
    to: envelopes.filter((e) => e.id === revision.id).map((e) => e.to),
  }));
}

const idOf = (person: Person) => person.vault.identity.public.id;

describe('ending a folder share', () => {
  it('takes it from everyone but the owners, keeps every version theirs, and frees the folder above', async () => {
    const [alice, rae, ed, gus] = await Promise.all([
      personWithVault(t),
      personWithVault(t),
      personWithVault(t),
      personWithVault(t),
    ]);
    const lib = await library(alice);
    const { spaceId, page } = lib;
    const groupId = await makeGroup(alice, spaceId, 'Family');
    await addToGroup(alice, spaceId, groupId, gus);
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, rae, 'reader'), await invite(alice, ed, 'editor')],
    });
    await shareWithGroup(alice, {
      spaceId,
      shareId,
      groupId,
      access: { role: 'reader', canPublish: false },
      sealTo: [gus],
    });
    const agent = await enrolledAgent(t, ed, {
      picks: [{ spaceId, folderId: lib.shared, role: 'reader' }],
    });
    await pages.editDraft(ed.ctx, page, { markdown: 'by Ed' });
    await pages.publishPage(alice.ctx, page);
    const agentStatus = async () =>
      (await asAgent(t, agent.token, `/api/pages/${page.pageId}`)).status;
    expect(await agentStatus()).toBe(200);
    const history = await pages.loadHistory(alice.ctx, page);

    await endShare(alice, { spaceId, shareId, rootId: lib.shared });

    // The share is gone, with all that hung off it, but the group stays.
    expect(await leftOf(shareId)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(
      await t.db.select().from(schema.groups).where(eq(schema.groups.id, groupId)),
    ).toHaveLength(1);
    const listed = await alice.api.call(sharingRoutes.listShares, { params: { spaceId } });
    expect(listed.shares).toEqual([]);

    // Every version is sealed to Alice alone now, and opens for her there.
    expect(new Set((await keysOfPage(page.pageId)).map((k) => JSON.stringify(k)))).toEqual(
      new Set([JSON.stringify({ shareId: null, to: [idOf(alice)] })]),
    );
    expect(await pages.loadHistory(alice.ctx, page)).toHaveLength(history.length);
    const head = await draftHead(alice, page);
    const opened = await pages.openRevisions(alice.ctx, page, 'draft', [head], { fresh: true });
    expect(opened.get(head)?.region).toEqual({ kind: 'owner' });
    expect(opened.get(head)?.opened).toMatchObject({ payload: { markdown: 'by Ed' } });
    const tree = await spaceOperations.loadTree(alice.ctx, spaceId);
    const name = tree.folders.find((f) => f.id === lib.shared)?.metadata?.opened;
    expect(name?.kind === 'current' && name.metadata.name).toBe('Shared');

    // Nobody else reaches it: members, the group's member, the agent.
    for (const person of [rae, ed, gus]) {
      expect(await rejection(pages.loadPage(person.ctx, page.pageId))).toBe('not-found');
    }
    expect(await rejection(pages.editDraft(ed.ctx, page, { markdown: 'too late' }))).toBe(
      'not-found',
    );
    expect(await agentStatus()).toBe(404);

    const [event] = await t.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.action, 'share.ended'), eq(schema.auditEvents.targetId, shareId)),
      );
    expect(event?.details).toEqual({
      spaceId,
      rootId: lib.shared,
      members: [idOf(ed), idOf(gus), idOf(rae)].sort(),
      agents: [agent.agentId],
      groups: [groupId],
      records: expect.any(Number),
    });

    // The folder above can be shared now, and the history goes with it.
    await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.above,
      people: [await invite(alice, rae, 'reader')],
    });
    expect(await pages.loadHistory(rae.ctx, page)).toHaveLength(history.length);
  });

  it('answers a request sent again with `not-found`, as the share is gone', async () => {
    const [alice, rae] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const ending = {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      shareId: await shareFolder(alice.ctx, {
        spaceId: lib.spaceId,
        rootId: lib.shared,
        people: [await invite(alice, rae, 'reader')],
      }),
    };
    const body = {
      permissionVersion: await rootVersion(ending.spaceId, ending.rootId),
      ...(await sealEnding(alice.ctx, ending)),
    };
    const send = () =>
      alice.api.call(sharingRoutes.endShare, { params: { shareId: ending.shareId }, body });
    expect(await rejection(send())).toBe('no error');
    expect(await rejection(send())).toBe('not-found');
  });
});

describe('ending the space share', () => {
  it('gives the space’s name back to the owners, and a folder in it can be shared', async () => {
    const [alice, rae] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId } = lib;
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: null,
      people: [await invite(alice, rae, 'editor')],
    });
    expect(await rejection(spaceOperations.loadTree(rae.ctx, spaceId))).toBe('no error');

    await endShare(alice, { spaceId, shareId, rootId: null });

    expect(await leftOf(shareId)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const names = await t.db
      .select({ to: schema.keyEnvelopes.recipientIdentityId })
      .from(schema.metadataRevisions)
      .innerJoin(
        schema.keyEnvelopes,
        and(
          eq(schema.keyEnvelopes.subjectKind, 'metadata'),
          eq(schema.keyEnvelopes.subjectId, schema.metadataRevisions.id),
        ),
      )
      .where(
        and(
          eq(schema.metadataRevisions.spaceId, spaceId),
          eq(schema.metadataRevisions.subjectKind, 'space'),
        ),
      );
    expect(names.map((row) => row.to)).toEqual([idOf(alice)]);
    expect(await rejection(spaceOperations.loadTree(rae.ctx, spaceId))).toBe('not-found');
    const tree = await spaceOperations.loadTree(alice.ctx, spaceId);
    const name = tree.space?.metadata?.opened;
    expect(name?.kind === 'current' && name.metadata.name).toBe(SPACE);
    expect(await rejection(pages.editDraft(alice.ctx, lib.page, { markdown: 'mine' }))).toBe(
      'no error',
    );
    await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, rae, 'reader')],
    });
    expect(await rejection(pages.loadPage(rae.ctx, lib.page.pageId))).toBe('no error');
  });
});

describe('the preview of an ending', () => {
  it('lists the public links that end and stay, and the publications, for owners only', async () => {
    const [alice, rae, outsider] = await Promise.all([
      personWithVault(t),
      personWithVault(t),
      personWithVault(t),
    ]);
    const lib = await library(alice);
    const { spaceId, page } = lib;
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, rae, 'editor', true)],
    });
    const owned = await pages.createPage(alice.ctx, {
      spaceId,
      parentId: lib.shared,
      title: 'Owned link',
      markdown: 'owner words',
    });
    await pages.publishPage(alice.ctx, { spaceId, pageId: owned });
    await links.turnOn(rae.ctx, page.pageId);
    await links.turnOn(alice.ctx, owned);

    // A publication from the folder into another space, and one into it.
    const other = await spaceOperations.createSpace(alice.ctx, { name: 'Other' });
    const { publishedHead } = (await pages.loadPage(alice.ctx, page.pageId)).heads;
    if (!publishedHead) throw new Error('expected a publication');
    await pubs.publishToSpace(alice.ctx, {
      preview: await pubs.previewPublication(alice.ctx, {
        source: page,
        revisionId: publishedHead,
        audience: 'published',
        spaceId: other,
        parentId: null,
      }),
      attachmentIds: new Set(),
    });
    const source = await pages.createPage(alice.ctx, {
      spaceId: other,
      parentId: null,
      title: 'From elsewhere',
      markdown: 'elsewhere',
    });
    const { revisionId: sourceVersion } = await pages.publishPage(alice.ctx, {
      spaceId: other,
      pageId: source,
    });
    const into = await pubs.publishToSpace(alice.ctx, {
      preview: await pubs.previewPublication(alice.ctx, {
        source: { spaceId: other, pageId: source },
        revisionId: sourceVersion,
        audience: 'published',
        spaceId,
        parentId: lib.shared,
      }),
      attachmentIds: new Set(),
    });

    const ending = await alice.api.call(sharingRoutes.shareEnding, { params: { shareId } });
    expect(ending.links).toHaveLength(2);
    expect(ending.links).toEqual(
      expect.arrayContaining([
        { pageId: page.pageId, ends: true },
        { pageId: owned, ends: false },
      ]),
    );
    expect(ending.publishedFrom).toEqual([page.pageId]);
    expect(ending.publishedInto).toEqual([into.pageId]);
    const asked = (person: Person) =>
      rejection(person.api.call(sharingRoutes.shareEnding, { params: { shareId } }));
    expect(await asked(rae)).toBe('forbidden');
    expect(await asked(outsider)).toBe('not-found');

    // And the ending does as it said: Rae's link ends, Alice's stays, and so do the publications.
    await endShare(alice, { spaceId, shareId, rootId: lib.shared });
    const left = await t.db.select({ pageId: schema.publicLinks.pageId }).from(schema.publicLinks);
    const linked = new Set(left.map((row) => row.pageId));
    expect([linked.has(page.pageId), linked.has(owned)]).toEqual([false, true]);
    const live = await t.db
      .select({ to: schema.publications.destinationPageId })
      .from(schema.publications)
      .where(eq(schema.publications.sourcePageId, page.pageId));
    expect(live).toHaveLength(1);
    expect(
      await t.db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.destinationPageId, into.pageId)),
    ).toMatchObject([{ detachedAt: null }]);
  });
});

describe('an ending is refused', () => {
  /** Alice's library with its folder shared with Ed, an editor. */
  async function shared() {
    const [alice, ed, outsider] = await Promise.all([
      personWithVault(t),
      personWithVault(t),
      personWithVault(t),
    ]);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, ed, 'editor')],
    });
    const ending = { spaceId: lib.spaceId, shareId, rootId: lib.shared };
    return { alice, ed, outsider, lib, ending };
  }

  it('for anyone but an owner, a stale preview, or keys not to exactly the owners', async () => {
    const { alice, ed, outsider, lib, ending } = await shared();
    const empty = {
      permissionVersion: await rootVersion(ending.spaceId, ending.rootId),
      keyEnvelopes: [],
      metadataEnvelopes: [],
    };
    const by = (person: Person) =>
      rejection(
        person.api.call(sharingRoutes.endShare, {
          params: { shareId: ending.shareId },
          body: empty,
        }),
      );
    expect(await by(ed)).toBe('forbidden');
    expect(await by(outsider)).toBe('not-found');

    // A change of access since the preview moves the root's permission version on.
    const stale = tampering(alice.ctx, sharingRoutes.endShare, (body) => ({
      ...body,
      permissionVersion: Number(body['permissionVersion']) - 1,
    }));
    expect(await rejection(endShare(alice, ending, stale))).toBe('permission-version');
    // One owner listed twice is not exactly the owners.
    const twice = tampering(alice.ctx, sharingRoutes.endShare, (body) => {
      const envelopes = body['keyEnvelopes'] as unknown[];
      return { ...body, keyEnvelopes: [...envelopes, envelopes[0]] };
    });
    expect(await rejection(endShare(alice, ending, twice))).toBe('recipients-mismatch');
    // One record left out: the app scans again.
    const short = tampering(alice.ctx, sharingRoutes.endShare, (body) => ({
      ...body,
      metadataEnvelopes: (body['metadataEnvelopes'] as unknown[]).slice(1),
    }));
    expect(await rejection(endShare(alice, ending, short))).toBe('stale-head');
    expect((await leftOf(ending.shareId))[0]).toBe(1);
    // Refused, it changed nothing: Ed still reads the folder.
    expect(await rejection(pages.loadPage(ed.ctx, lib.page.pageId))).toBe('no error');
  });

  it('while its folder is in the trash', async () => {
    const { alice, lib, ending } = await shared();
    const body = {
      permissionVersion: await rootVersion(ending.spaceId, ending.rootId),
      ...(await sealEnding(alice.ctx, ending)),
    };
    await pages.deleteNode(alice.ctx, { spaceId: lib.spaceId, nodeId: lib.shared });
    expect(
      await rejection(
        alice.api.call(sharingRoutes.endShare, { params: { shareId: ending.shareId }, body }),
      ),
    ).toBe('forbidden');
  });

  it('when a version was saved, or a page moved out, since the scan, until the app scans again', async () => {
    const { alice, ed, lib, ending } = await shared();
    const { spaceId, page } = lib;
    let saved: RevisionId | null = null;
    const meanwhile = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.endShare,
          async (input, send) => {
            if (!saved)
              ({ revisionId: saved } = await pages.editDraft(ed.ctx, page, {
                markdown: 'meanwhile',
              }));
            return send(input);
          },
        ],
      ]),
    );
    expect(await rejection(endShare(alice, ending, meanwhile.ctx))).toBe('stale-head');

    // A page moved out of the folder since the scan: its envelopes are for
    // records no longer under the share.
    const out = await pages.createPage(alice.ctx, { spaceId, parentId: lib.shared, title: 'Out' });
    const withOut = {
      permissionVersion: await rootVersion(spaceId, ending.rootId),
      ...(await sealEnding(alice.ctx, ending)),
    };
    await moves.moveNode(alice.ctx, {
      preview: await moves.previewMove(alice.ctx, { spaceId, nodeId: out, parentId: lib.above }),
    });
    // The move bumped the root's version too, so it is sent at the current one.
    const now = await rootVersion(spaceId, ending.rootId);
    expect(
      await rejection(
        alice.api.call(sharingRoutes.endShare, {
          params: { shareId: ending.shareId },
          body: { ...withOut, permissionVersion: now },
        }),
      ),
    ).toBe('stale-head');

    // A folder in the trash deleted for good since the scan: its name is gone.
    const binned = await spaceOperations.createFolder(alice.ctx, {
      spaceId,
      parentId: lib.shared,
      name: 'Binned',
    });
    await pages.deleteNode(alice.ctx, { spaceId, nodeId: binned });
    const withBinned = {
      permissionVersion: await rootVersion(spaceId, ending.rootId),
      ...(await sealEnding(alice.ctx, ending)),
    };
    await trash.emptyTrash(alice.ctx, spaceId);
    expect(
      await rejection(
        alice.api.call(sharingRoutes.endShare, {
          params: { shareId: ending.shareId },
          body: { ...withBinned, permissionVersion: await rootVersion(spaceId, ending.rootId) },
        }),
      ),
    ).toBe('stale-head');

    // Scanned again, it ends, and the version saved meanwhile is Alice's.
    await endShare(alice, ending);
    if (!saved) throw new Error('expected the save');
    const opened = await pages.openRevisions(alice.ctx, page, 'draft', [saved], { fresh: true });
    expect(opened.get(saved)?.opened).toMatchObject({ payload: { markdown: 'meanwhile' } });
  });
});

describe('writers who haven’t heard of an ending', () => {
  it('are refused: a move prepared before, and an owner’s save under the old keys, which goes to the owners', async () => {
    const [alice, ed] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId, page } = lib;
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, ed, 'editor')],
    });
    // Prepared before the ending: a move, and a save sealed under the share's keys.
    const preview = await moves.previewMove(alice.ctx, {
      spaceId,
      nodeId: page.pageId,
      parentId: lib.above,
    });
    const head = await draftHead(alice, page);
    const before = await writeTargetOf(alice.ctx, spaceId, page.pageId);
    const underShare = sealRevisionV2({
      author: alice.ctx.identity,
      target: {
        installationId: alice.ctx.installationId,
        ...page,
        revisionId: newId(RevisionId),
        audience: 'draft',
        basedOn: head,
      },
      payload: newPayload({ title: 'Plan', markdown: 'under the old keys' }),
      ...before.keyTarget,
    });
    expect(underShare.wrap?.shareId).toBe(shareId);

    await endShare(alice, { spaceId, shareId, rootId: lib.shared });

    // The app finds the records out of the share and refuses the move itself;
    // sent as it was prepared, with no keys now needed, the server refuses it.
    expect(await rejection(moves.moveNode(alice.ctx, { preview }))).toBe('region-mismatch');
    const prepared = alice.api.call(sharingRoutes.move, {
      params: { spaceId, nodeId: page.pageId },
      body: {
        parentId: lib.above,
        expectedParentId: lib.shared,
        permissionVersion: preview.permissionVersion,
        parentPermissionVersion: preview.parentPermissionVersion,
      },
    });
    expect(await rejection(prepared)).toBe('permission-version');

    // A save under the old keys, at the current permission version, is in the wrong region.
    const after = await writeTargetOf(alice.ctx, spaceId, page.pageId);
    const saved = alice.api.call(pageRoutes.saveDraft, {
      params: { pageId: page.pageId },
      body: {
        ...underShare,
        blobRefs: [],
        permissionVersion: after.permissionVersion,
        restoredFrom: null,
      },
    });
    expect(await rejection(saved)).toBe('region-mismatch');
    // The app opens the draft again, now through Alice's envelope, and saves there.
    const written = await pages.editDraft(alice.ctx, page, { markdown: 'after the ending' });
    expect(written.region).toEqual({ kind: 'owner' });
    expect(await rejection(pages.editDraft(ed.ctx, page, { markdown: 'by Ed' }))).toBe('not-found');
  });
});

describe('the trash, when a share ends', () => {
  it('is sealed to the owners too, so what was deleted from the folder can be restored', async () => {
    const [alice, rae] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId } = lib;
    const deleted = async (title: string) => {
      const pageId = await pages.createPage(alice.ctx, {
        spaceId,
        parentId: lib.shared,
        title,
        markdown: `${title} words`,
      });
      return pageId;
    };
    const kept = await deleted('Kept');
    const later = await deleted('Later');
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, rae, 'reader')],
    });
    for (const nodeId of [kept, later]) await pages.deleteNode(alice.ctx, { spaceId, nodeId });

    await endShare(alice, { spaceId, shareId, rootId: lib.shared });

    for (const pageId of [kept, later]) {
      expect(new Set((await keysOfPage(pageId)).map((k) => JSON.stringify(k)))).toEqual(
        new Set([JSON.stringify({ shareId: null, to: [idOf(alice)] })]),
      );
    }
    const trashIdOf = async (nodeId: PageId) => {
      const entry = (await trash.loadTrash(alice.ctx)).find((item) => item.nodeId === nodeId);
      if (!entry) throw new Error(`expected ${nodeId} in the trash`);
      return entry.trashId;
    };
    await trash.restoreTrash(alice.ctx, await trashIdOf(kept));
    const draft = await draftHead(alice, { pageId: kept });
    const opened = await pages.openRevisions(alice.ctx, { spaceId, pageId: kept }, 'draft', [
      draft,
    ]);
    expect(opened.get(draft)?.opened).toMatchObject({ payload: { markdown: 'Kept words' } });

    // Sharing the folder above leaves the trash as it is: the rest no longer fits there.
    await shareFolder(alice.ctx, { spaceId, rootId: lib.above, people: [] });
    expect(await rejection(trash.restoreTrash(alice.ctx, await trashIdOf(later)))).toBe(
      'region-mismatch',
    );
  });
});

describe('the owner’s app ending a share', () => {
  it('scans again after a save meanwhile, counts a lost answer as done, and marks the share ended', async () => {
    const [alice, ed] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId, page } = lib;
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, ed, 'editor')],
    });
    const binned = await pages.createPage(alice.ctx, {
      spaceId,
      parentId: lib.shared,
      title: 'Binned',
    });
    await pages.deleteNode(alice.ctx, { spaceId, nodeId: binned });

    const preview = await ending.previewEnding(alice.ctx, { spaceId, shareId });
    expect(preview.people).toEqual([idOf(ed)]);

    // Ed saves after the scan; then the answer to the send that ends it is lost.
    let sends = 0;
    let saved: RevisionId | null = null;
    const flaky = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.endShare,
          async (input, send) => {
            sends += 1;
            if (sends === 1) {
              ({ revisionId: saved } = await pages.editDraft(ed.ctx, page, {
                markdown: 'meanwhile',
              }));
            }
            const answer = await send(input);
            if (sends === 2) throw new ApiError(0, 'network', 'The answer was lost');
            return answer;
          },
        ],
      ]),
    );
    const ended = await ending.endShare(flaky.ctx, { preview });
    // Refused as stale-head, sent again and ended, then found gone on the resend.
    expect(sends).toBe(3);
    expect(ended).toEqual({ fromTrash: true });
    expect(await leftOf(shareId)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(alice.ctx.marks.get(spaceId, shareId)).toBe(ENDED);
    if (!saved) throw new Error('expected the save');
    const opened = await pages.openRevisions(alice.ctx, page, 'draft', [saved], { fresh: true });
    expect(opened.get(saved)?.opened).toMatchObject({ payload: { markdown: 'meanwhile' } });
    // What was deleted from it restores, now the owners'.
    const [item] = (await trash.loadTrash(alice.ctx)).filter((i) => i.nodeId === binned);
    if (!item) throw new Error('expected it in the trash');
    await trash.restoreTrash(alice.ctx, item.trashId);
  });
});
