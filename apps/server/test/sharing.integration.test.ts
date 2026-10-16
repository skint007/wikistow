import {
  newId,
  newPayload,
  groupOperations,
  ownerOperations as owners,
  pageOperations as pages,
  RevisionId,
  sealRevisionV2,
  sharingOperations as sharing,
  ShareId,
  spaceOperations,
  unwrapContentKey,
  revisionWrapSubject,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import { KeyWrap, pageRoutes, RevisionRecordV2, sharingRoutes } from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { milestone1Library } from './support/milestone1.ts';
import { personWithVault, rejection } from './support/content.ts';
import {
  ABOVE,
  draftHead,
  find,
  invite,
  library,
  lyingServer,
  shareFolder,
  SPACE,
  tampering,
  type Person,
} from './support/sharing.ts';
import {
  addToGroup,
  giveAccessTo,
  makeGroup,
  removeFromGroup,
  shareWithGroup,
  waitingIn,
} from './support/groups.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { keysOf, whatOpens } from './support/opens.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const shareOf = async (owner: Person, spaceId: SpaceId) => {
  const [share] = await sharing.listShares(owner.ctx, spaceId);
  if (!share) throw new Error('expected a share');
  return share;
};

describe('a folder share', () => {
  it('lets each role do what it allows and nothing more', async () => {
    const alice = await personWithVault(t);
    const [editor, outsider] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, editor, 'editor')],
    });
    const { spaceId } = lib;
    // Members take no owner action, and outsiders aren't told the space exists.
    const shareId = (await shareOf(alice, spaceId)).shareId;
    for (const [p, code] of [
      [editor, 'forbidden'],
      [outsider, 'not-found'],
    ] as const) {
      expect(
        await rejection(
          p.api.call(sharingRoutes.rotate, {
            params: { shareId },
            body: {
              expectedKeyVersion: 1,
              removed: [],
              demoted: [],
              envelopes: [],
              permissionVersion: 1,
            },
          }),
        ),
      ).toBe(code);
    }
    // The space's name is the owners' to change, even for an editor who holds its share.
    expect(
      await rejection(
        spaceOperations.createFolder(editor.ctx, { spaceId, parentId: null, name: 'Top' }),
      ),
    ).toBe('not-found');
  });
});

describe('removing a member', () => {
  it('leaves them nothing to fetch, and no key for anything saved afterwards', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const carol = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'editor'), await invite(alice, carol, 'reader')],
    });
    expect((await pages.loadPage(bob.ctx, lib.page.pageId)).heads.draftHead).not.toBeNull();
    // Bob keeps the version-1 keys he opened.
    await spaceOperations.loadTree(bob.ctx, lib.spaceId);
    expect(bob.ctx.keyring.versions(lib.spaceId, shareId).map((v) => v.keyVersion)).toEqual([1]);

    const planned = await sharing.planShareRotation(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      leaveOut: [bob.vault.identity.public.id],
    });
    expect(planned.plan.removed).toEqual([bob.vault.identity.public.id]);
    expect(await sharing.applyShareRotation(alice.ctx, planned)).toBe(2);

    const { revisionId: after } = await pages.editDraft(alice.ctx, lib.page, {
      markdown: 'written after Bob left',
    });
    for (const call of [
      () => pages.loadPage(bob.ctx, lib.page.pageId),
      () => spaceOperations.loadTree(bob.ctx, lib.spaceId),
      () => bob.api.call(sharingRoutes.myEnvelopes, { params: { spaceId: lib.spaceId } }),
      () => bob.api.call(sharingRoutes.versionEnvelopes, { params: { shareId, keyVersion: 1 } }),
    ]) {
      expect(await rejection(call())).toBe('not-found');
    }
    const { revisions } = await bob.api.call(pageRoutes.fetchRevisions, { body: { ids: [after] } });
    expect(revisions).toEqual([]);
    // What was saved afterwards is wrapped under version 2, which he never held.
    const [row] = await t.db
      .select({ sealed: schema.revisions.sealed, wrap: schema.revisionWraps.wrap })
      .from(schema.revisions)
      .innerJoin(schema.revisionWraps, eq(schema.revisionWraps.revisionId, schema.revisions.id))
      .where(eq(schema.revisions.id, after));
    const wrap = KeyWrap.parse(row?.wrap);
    expect(wrap.keyVersion).toBe(2);
    const record = RevisionRecordV2.parse(
      (row?.sealed as { record?: unknown } | undefined)?.record,
    );
    expect(() =>
      unwrapContentKey({
        installationId: bob.ctx.installationId,
        subject: revisionWrapSubject(record),
        wrap,
        keyring: bob.ctx.keyring,
        commitment: record.keyCommitment,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing-key' }));
    // Nor is version 2 sealed to him anywhere.
    const sealedToBob = await t.db
      .select()
      .from(schema.folderKeyEnvelopes)
      .where(
        and(
          eq(schema.folderKeyEnvelopes.shareId, shareId),
          eq(schema.folderKeyEnvelopes.keyVersion, 2),
          eq(schema.folderKeyEnvelopes.recipientIdentityId, bob.vault.identity.public.id),
        ),
      );
    expect(sealedToBob).toEqual([]);
    // Carol, who stayed, reads on; the newer draft isn't hers to read.
    expect((await pages.loadHistory(carol.ctx, lib.page)).length).toBe(1);
  });

  it('refuses a save under the old key version, and the editor’s app wraps again', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const carol = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'editor'), await invite(alice, carol, 'editor')],
    });
    // Bob prepares a save under version 1, then Alice removes Carol.
    const head = await draftHead(bob, lib.page);
    const stale = await writeTargetOf(bob.ctx, lib.spaceId, lib.page.pageId);
    const sealed = sealRevisionV2({
      author: bob.ctx.identity,
      target: {
        installationId: bob.ctx.installationId,
        ...lib.page,
        revisionId: newId(RevisionId),
        audience: 'draft',
        basedOn: head,
      },
      payload: newPayload({ title: 'Plan', markdown: 'late' }),
      ...stale.keyTarget,
    });
    await sharing.removeMember(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: carol.vault.identity.public.id,
    });
    const refused = await bob.api
      .call(pageRoutes.saveDraft, {
        params: { pageId: lib.page.pageId },
        body: {
          ...sealed,
          blobRefs: [],
          permissionVersion: stale.permissionVersion + 1,
          restoredFrom: null,
        },
      })
      .catch((error: { code?: string; detail?: unknown }) => error);
    expect(refused).toMatchObject({ code: 'key-version', detail: { keyVersion: 2 } });
    // His app works the space out again and wraps under version 2.
    expect(await rejection(pages.editDraft(bob.ctx, lib.page, { markdown: 'again' }))).toBe(
      'no error',
    );
  });

  it('refuses a rotation from a stale key or permission version', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'reader')],
    });
    const planned = await sharing.planShareRotation(alice.ctx, { spaceId: lib.spaceId, shareId });
    const send = (change: (body: Record<string, unknown>) => Record<string, unknown>) =>
      rejection(
        sharing.applyShareRotation(tampering(alice.ctx, sharingRoutes.rotate, change), planned),
      );
    expect(await send((body) => ({ ...body, expectedKeyVersion: 7 }))).toBe('stale-head');
    expect(await send((body) => body)).toBe('no error');
    // Planned before version 2 existed, it is refused before anything else.
    expect(await rejection(sharing.applyShareRotation(alice.ctx, planned))).toBe(
      'permission-version',
    );
  });

  it('removes someone from every share in the space at once', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'reader')],
    });
    const other = await spaceOperations.createFolder(alice.ctx, {
      spaceId: lib.spaceId,
      parentId: null,
      name: 'Other',
    });
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: other,
      people: [await invite(alice, bob, 'editor')],
    });
    expect((await sharing.sharedWithMe(bob.ctx)).length).toBe(2);
    const change = await groupOperations.planRemovalEverywhere(alice.ctx, {
      spaceId: lib.spaceId,
      identityId: bob.vault.identity.public.id,
    });
    expect(change.rotations.length).toBe(2);
    await groupOperations.applyGroupChange(alice.ctx, change);
    expect(await sharing.sharedWithMe(bob.ctx)).toEqual([]);
    expect((await sharing.listShares(alice.ctx, lib.spaceId)).map((s) => s.members)).toEqual([
      [],
      [],
    ]);
  });
});

describe('making a share', () => {
  it('refuses a share inside a share, around one, or of a space that has one', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    const inner = await spaceOperations.createFolder(alice.ctx, {
      spaceId: lib.spaceId,
      parentId: lib.shared,
      name: 'Inner',
    });
    const first = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'reader')],
    });
    for (const rootId of [inner, lib.above, null] as (FolderId | null)[]) {
      // The owner's app finds records already in a share, and stops.
      expect(
        await rejection(shareFolder(alice.ctx, { spaceId: lib.spaceId, rootId, people: [] })),
        String(rootId),
      ).toBe('region-mismatch');
      // Straight to the server, which names the share in the way.
      const refused = await alice.api
        .call(sharingRoutes.makeShare, {
          params: { spaceId: lib.spaceId },
          body: {
            shareId: newId(ShareId),
            rootId,
            wraps: [],
            envelopes: [],
            members: [],
            permissionVersion: 1,
          },
        })
        .catch((error: { code?: string; detail?: unknown }) => error);
      expect(refused, String(rootId)).toMatchObject({
        code: 'share-nesting',
        detail: { shareId: first },
      });
    }
  });

  it('refuses a share that leaves out a wrap', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    const make = (change: (body: Record<string, unknown>) => Record<string, unknown>) =>
      rejection(
        shareFolder(tampering(alice.ctx, sharingRoutes.makeShare, change), {
          spaceId: lib.spaceId,
          rootId: lib.shared,
          people: [],
        }),
      );
    const wraps = (body: Record<string, unknown>) => body['wraps'] as unknown[];
    expect(await make((body) => ({ ...body, wraps: wraps(body).slice(1) }))).toBe('stale-head');
    // The share was never made, and the folder is still in the owner region.
    expect(await sharing.listShares(alice.ctx, lib.spaceId)).toEqual([]);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'reader')],
    });
    expect(ShareId.parse(shareId)).toBe(shareId);
  });

  it('refuses a write whose key material is for another region', async () => {
    const alice = await personWithVault(t);
    const lib = await library(alice);
    // Prepared in the owner region, before the folder is shared.
    const head = await draftHead(alice, lib.page);
    const before = await writeTargetOf(alice.ctx, lib.spaceId, lib.page.pageId);
    const seal = (to: typeof before.keyTarget) =>
      sealRevisionV2({
        author: alice.ctx.identity,
        target: {
          installationId: alice.ctx.installationId,
          ...lib.page,
          revisionId: newId(RevisionId),
          audience: 'draft',
          basedOn: head,
        },
        payload: newPayload({ title: 'Plan', markdown: 'x' }),
        ...to,
      });
    const sealedToOwners = seal(before.keyTarget);
    await shareFolder(alice.ctx, { spaceId: lib.spaceId, rootId: lib.shared, people: [] });
    const after = await writeTargetOf(alice.ctx, lib.spaceId, lib.page.pageId);
    const save = (commit: ReturnType<typeof seal>) =>
      rejection(
        alice.api.call(pageRoutes.saveDraft, {
          params: { pageId: lib.page.pageId },
          body: {
            ...commit,
            blobRefs: [],
            permissionVersion: after.permissionVersion,
            restoredFrom: null,
          },
        }),
      );
    expect(await save(sealedToOwners)).toBe('region-mismatch');
    const wrapped = seal(after.keyTarget);
    // A private page beside the share takes no wrap.
    const besideHead = await draftHead(alice, lib.beside);
    const beside = sealRevisionV2({
      author: alice.ctx.identity,
      target: {
        installationId: alice.ctx.installationId,
        ...lib.beside,
        revisionId: newId(RevisionId),
        audience: 'draft',
        basedOn: besideHead,
      },
      payload: newPayload({ title: 'Private', markdown: 'x' }),
      ...after.keyTarget,
    });
    const target = await writeTargetOf(alice.ctx, lib.spaceId, lib.beside.pageId);
    expect(
      await rejection(
        alice.api.call(pageRoutes.saveDraft, {
          params: { pageId: lib.beside.pageId },
          body: {
            ...beside,
            blobRefs: [],
            permissionVersion: target.permissionVersion,
            restoredFrom: null,
          },
        }),
      ),
    ).toBe('region-mismatch');
    expect(await save(wrapped)).toBe('no error');
  });

  it('wraps only what the owner previewed, whatever the server’s scan adds or leaves out', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    const preview = await sharing.previewShare(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
    });
    expect(preview.folders.map((f) => [f.id, f.metadata?.opened])).toEqual([
      [lib.shared, { kind: 'current', metadata: expect.objectContaining({ name: 'Shared' }) }],
    ]);
    expect(preview.pages.map((p) => [p.id, p.title])).toEqual([[lib.page.pageId, 'Plan']]);
    const people = [await invite(alice, bob, 'reader')];
    type Scan = { records: { kind: string; revision?: unknown; metadata?: unknown }[] };
    const isSpaceName = (item: Scan['records'][number]) =>
      (item.metadata as { record?: { subjectKind?: string } } | undefined)?.record?.subjectKind ===
      'space';
    const pageOf = (item: Scan['records'][number]) =>
      (item.revision as { record?: { pageId?: string } } | undefined)?.record?.pageId;

    // The scan answers with the owner region: the name of the folder above
    // the share, and the private page beside it.
    const widened = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.records,
          async (input, send) => {
            const { rootId: _, ...query } = input.query ?? {};
            const scan: Scan = await send({ ...input, query: { ...query, scope: 'owner-region' } });
            return { ...scan, records: scan.records.filter((item) => !isSpaceName(item)) };
          },
        ],
      ]),
    );
    expect(await rejection(sharing.shareFolder(widened.ctx, { preview, people }))).toBe(
      'binding-mismatch',
    );
    expect(widened.sent).not.toContain(sharingRoutes.makeShare);

    // The scan leaves out the shared page: the share would be silently partial.
    const narrowed = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.records,
          async (input, send) => {
            const scan: Scan = await send(input);
            return {
              ...scan,
              records: scan.records.filter((item) => pageOf(item) !== lib.page.pageId),
            };
          },
        ],
      ]),
    );
    expect(await rejection(sharing.shareFolder(narrowed.ctx, { preview, people }))).toBe(
      'binding-mismatch',
    );
    expect(narrowed.sent).not.toContain(sharingRoutes.makeShare);
    expect(await sharing.listShares(alice.ctx, lib.spaceId)).toEqual([]);

    // The honest scan matches the preview.
    await sharing.shareFolder(alice.ctx, { preview, people });
    const [item] = await sharing.sharedWithMe(bob.ctx);
    expect(item?.root?.opened).toMatchObject({ metadata: { name: 'Shared' } });
  });
});

describe('adding a member', () => {
  it('turns a reader into an editor, but not back again', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const carol = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, carol, 'reader')],
    });
    await sharing.rotateKeys(alice.ctx, { spaceId: lib.spaceId, shareId });
    const add = (ctx: typeof alice.ctx, role: 'reader' | 'editor') =>
      find(alice, bob).then((person) =>
        rejection(sharing.addMember(ctx, { spaceId: lib.spaceId, shareId, person, role })),
      );
    expect(await add(alice.ctx, 'reader')).toBe('no error');
    await spaceOperations.loadTree(bob.ctx, lib.spaceId);
    expect(bob.ctx.keyring.keysFor(lib.spaceId, shareId, 2, 'draft')).toEqual([]);

    // Made an editor, Bob's reader envelopes are replaced by ones with draft keys,
    // which his app fetches as soon as it finds it lacks one.
    expect(await add(alice.ctx, 'editor')).toBe('no error');
    expect(
      await rejection(
        pages.createPage(bob.ctx, { spaceId: lib.spaceId, parentId: lib.shared, title: 'New' }),
      ),
    ).toBe('no error');
    const mine = await bob.api.call(sharingRoutes.myEnvelopes, {
      params: { spaceId: lib.spaceId },
    });
    expect(mine.envelopes.map((e) => [e.keyVersion, e.draftKey !== null])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(await rejection(pages.editDraft(bob.ctx, lib.page, { markdown: 'mine' }))).toBe(
      'no error',
    );
    // Back to reader is a rotation, never this route.
    expect(await add(alice.ctx, 'reader')).toBe('forbidden');
  });

  it('never passes on another space’s share keys, whatever shares the server lists', async () => {
    const alice = await personWithVault(t);
    const carol = await personWithVault(t);
    const dave = await personWithVault(t);
    const a = await library(alice);
    const b = await library(alice);
    await shareFolder(alice.ctx, { spaceId: a.spaceId, rootId: a.shared, people: [] });
    const shareB = await shareFolder(alice.ctx, {
      spaceId: b.spaceId,
      rootId: b.shared,
      people: [await invite(alice, carol, 'reader')],
    });
    // Alice's app holds space B's keys, sealed by her, in this session.
    await spaceOperations.loadTree(alice.ctx, b.spaceId);
    expect(alice.ctx.keyring.keysFor(b.spaceId, shareB, 1, 'draft')).toHaveLength(1);
    const [rowB] = await sharing.listShares(alice.ctx, b.spaceId);
    if (!rowB) throw new Error('expected the share');

    // Space A's share list gains space B's share, rooted in A, or relabelled as A's.
    const listing = (extra: typeof rowB) =>
      lyingServer(
        alice.ctx,
        new Map([
          [
            sharingRoutes.listShares,
            async (input, send) => {
              const { shares }: { shares: (typeof rowB)[] } = await send(input);
              return { shares: [...shares, extra] };
            },
          ],
        ]),
      );
    const toDave = async (lying: ReturnType<typeof listing>) => {
      const person = await find(alice, dave);
      const code = await rejection(
        sharing.addMember(lying.ctx, {
          spaceId: a.spaceId,
          shareId: shareB,
          person,
          role: 'reader',
        }),
      );
      expect(lying.sent).not.toContain(sharingRoutes.addMember);
      return code;
    };
    expect(await toDave(listing({ ...rowB, rootId: a.shared }))).toBe('binding-mismatch');
    expect(await toDave(listing({ ...rowB, spaceId: a.spaceId }))).toBe('missing-key');
  });

  it('turns an editor’s publish rights on and off without sealing anything', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'editor')],
    });
    const bobId = bob.vault.identity.public.id;
    const rights = (canPublish: boolean) =>
      sharing.setPublishRights(alice.ctx, {
        spaceId: lib.spaceId,
        shareId,
        identityId: bobId,
        canPublish,
      });
    expect(await rejection(pages.publishPage(bob.ctx, lib.page))).toBe('forbidden');
    await rights(true);
    expect(await rejection(pages.publishPage(bob.ctx, lib.page))).toBe('no error');
    await rights(false);
    expect(await rejection(pages.publishPage(bob.ctx, lib.page))).toBe('forbidden');
  });
});

describe('a Milestone 1 space', () => {
  const words = async (
    person: Person,
    page: { spaceId: SpaceId; pageId: PageId },
    audience: 'draft' | 'published',
    id: RevisionId,
  ) => (await pages.openRevisionOf(person.ctx, page, audience, id)).opened;
  const folderName = async (person: Person, spaceId: SpaceId, folderId: FolderId) =>
    (await spaceOperations.loadTree(person.ctx, spaceId)).folders.find((f) => f.id === folderId)
      ?.metadata?.opened;

  it('is shared with an editor, who opens and edits its v1 records, as its owner still does', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await milestone1Library(t, alice);
    // Its Milestone 1 owner opens and edits it as before.
    expect(await words(alice, lib.page, 'draft', lib.v1.draft)).toMatchObject({
      payload: { markdown: 'M1 draft words' },
    });
    expect(await folderName(alice, lib.spaceId, lib.shared)).toMatchObject({
      metadata: { name: 'Shared (M1)' },
    });
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'editor')],
    });

    // Bob opens the v1 draft, publication and folder name through the share.
    expect(await words(bob, lib.page, 'draft', lib.v1.draft)).toMatchObject({
      payload: { markdown: 'M1 draft words' },
    });
    expect(await words(bob, lib.page, 'published', lib.v1.published)).toMatchObject({
      payload: { markdown: 'M1 published words' },
    });
    expect(await folderName(bob, lib.spaceId, lib.shared)).toMatchObject({
      metadata: { name: 'Shared (M1)' },
    });
    // He edits the page and renames the folder, on top of the v1 heads.
    const edited = await pages.editDraft(bob.ctx, lib.page, { markdown: 'Bob’s words' });
    const tree = await spaceOperations.loadTree(bob.ctx, lib.spaceId);
    const [folder] = tree.folders;
    if (!folder?.metadata) throw new Error('expected the folder');
    await spaceOperations.updateMetadata(bob.ctx, {
      spaceId: lib.spaceId,
      subject: { kind: 'folder', folderId: lib.shared },
      current: folder.metadata,
      changes: { name: 'Shared by Bob' },
    });
    // Alice reads both, and still edits the shared page and her private one.
    expect(await words(alice, lib.page, 'draft', edited.revisionId)).toMatchObject({
      payload: { markdown: 'Bob’s words' },
    });
    expect(await folderName(alice, lib.spaceId, lib.shared)).toMatchObject({
      metadata: { name: 'Shared by Bob' },
    });
    for (const page of [lib.page, lib.beside]) {
      expect(await rejection(pages.editDraft(alice.ctx, page, { markdown: 'Alice again' }))).toBe(
        'no error',
      );
    }
    expect(await words(alice, lib.beside, 'draft', lib.v1.private)).toMatchObject({
      payload: { markdown: 'M1 private words' },
    });
  });

  it('is shared whole, its v1 name and all', async () => {
    const alice = await personWithVault(t);
    const carol = await personWithVault(t);
    const lib = await milestone1Library(t, alice);
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: null,
      people: [await invite(alice, carol, 'reader')],
    });
    const [item] = await sharing.sharedWithMe(carol.ctx);
    expect(item?.root?.opened).toMatchObject({ metadata: { name: SPACE } });
    expect(await folderName(carol, lib.spaceId, lib.above)).toMatchObject({
      metadata: { name: ABOVE },
    });
    expect(await words(carol, lib.page, 'published', lib.v1.published)).toMatchObject({
      payload: { markdown: 'M1 published words' },
    });
  });

  it('takes a co-owner, who opens its v1 records in the owner region', async () => {
    const alice = await personWithVault(t);
    const quinn = await personWithVault(t);
    const lib = await milestone1Library(t, alice);
    await owners.addCoOwner(alice.ctx, { spaceId: lib.spaceId, person: await find(alice, quinn) });
    const adder = await owners.ownerToConfirm(quinn.ctx, lib.spaceId);
    if (!adder) throw new Error('expected the co-owner dialog');
    await owners.confirmOwner(quinn.ctx, { spaceId: lib.spaceId, adder });
    expect(await words(quinn, lib.beside, 'draft', lib.v1.private)).toMatchObject({
      payload: { markdown: 'M1 private words' },
    });
    expect(await words(quinn, lib.page, 'published', lib.v1.published)).toMatchObject({
      payload: { markdown: 'M1 published words' },
    });
    const tree = await spaceOperations.loadTree(quinn.ctx, lib.spaceId);
    expect(tree.space?.metadata?.opened).toMatchObject({ metadata: { name: SPACE } });
    expect(await folderName(quinn, lib.spaceId, lib.above)).toMatchObject({
      metadata: { name: ABOVE },
    });
    // Both owners write on.
    for (const owner of [quinn, alice]) {
      expect(await rejection(pages.editDraft(owner.ctx, lib.beside, { markdown: 'on' }))).toBe(
        'no error',
      );
    }
  });
});

// Lock waits in the test database, to step a race one move at a time.
const waitingForLocks = async (count: number) => {
  for (let i = 0; ; i++) {
    const [row] = [
      ...(await t.db.execute<{ count: string }>(sql`
        select count(*) from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`)),
    ];
    if (Number(row?.count ?? 0) >= count) return;
    if (i > 500) throw new Error(`never ${count} waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('the key version check', () => {
  it('holds a save until a rotation in progress is stored, then refuses it', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(alice, bob, 'editor')],
    });
    const head = await draftHead(bob, lib.page);
    const target = await writeTargetOf(bob.ctx, lib.spaceId, lib.page.pageId);
    const commit = {
      ...sealRevisionV2({
        author: bob.ctx.identity,
        target: {
          installationId: bob.ctx.installationId,
          ...lib.page,
          revisionId: newId(RevisionId),
          audience: 'draft',
          basedOn: head,
        },
        payload: newPayload({ title: 'Plan', markdown: 'racing a rotation' }),
        ...target.keyTarget,
      }),
      blobRefs: [],
      permissionVersion: target.permissionVersion,
      restoredFrom: null,
    };
    // Alice's real rotation takes the share's row and stores the new
    // version, then stops where it moves the space's permission version on,
    // which this transaction holds (writes only key-share it). Bob's save
    // must then wait for the share, not slip in under version 1.
    let rotation: Promise<number> | undefined;
    let save: Promise<string | undefined> | undefined;
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select id from spaces where id = ${lib.spaceId} for no key update`);
      rotation = sharing.rotateKeys(alice.ctx, { spaceId: lib.spaceId, shareId });
      await waitingForLocks(1);
      save = rejection(
        bob.api.call(pageRoutes.saveDraft, { params: { pageId: lib.page.pageId }, body: commit }),
      );
      await waitingForLocks(2);
    });
    expect(await rotation).toBe(2);
    // The rotation moved the permission versions on too, which the save is
    // checked against first; either way nothing is stored under version 1.
    expect(await save).toBe('permission-version');
    expect(await draftHead(alice, lib.page)).toBe(head);
  });
});

/** Whether `person`'s own keys open the stored revision `revisionId`, trying its wrap. */
async function opensWith(person: Person, revisionId: RevisionId) {
  const [row] = await t.db
    .select({ sealed: schema.revisions.sealed, wrap: schema.revisionWraps.wrap })
    .from(schema.revisions)
    .innerJoin(schema.revisionWraps, eq(schema.revisionWraps.revisionId, schema.revisions.id))
    .where(eq(schema.revisions.id, revisionId));
  const record = RevisionRecordV2.parse((row?.sealed as { record?: unknown } | undefined)?.record);
  try {
    unwrapContentKey({
      installationId: person.ctx.installationId,
      subject: revisionWrapSubject(record),
      wrap: KeyWrap.parse(row?.wrap),
      keyring: person.ctx.keyring,
      commitment: record.keyCommitment,
    });
    return true;
  } catch (error) {
    expect(error).toMatchObject({ code: 'missing-key' });
    return false;
  }
}

describe('a group', () => {
  it('loses a removed member every share it has, rotating each, so their keys open nothing saved after', async () => {
    const alice = await personWithVault(t);
    const [bob, carol] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId } = lib;
    const second = await spaceOperations.createFolder(alice.ctx, {
      spaceId,
      parentId: lib.above,
      name: 'Second',
    });
    const notes = {
      spaceId,
      pageId: await pages.createPage(alice.ctx, {
        spaceId,
        parentId: second,
        title: 'Notes',
        markdown: 'second words',
      }),
    };
    const first = await shareFolder(alice.ctx, { spaceId, rootId: lib.shared, people: [] });
    const other = await shareFolder(alice.ctx, { spaceId, rootId: second, people: [] });
    const family = await makeGroup(alice, spaceId, 'Family');
    await addToGroup(alice, spaceId, family, carol);
    for (const [shareId, role] of [
      [first, 'reader'],
      [other, 'editor'],
    ] as const) {
      await shareWithGroup(alice, {
        spaceId,
        shareId,
        groupId: family,
        access: { role, canPublish: false },
        sealTo: [carol],
      });
    }
    // Bob joins later, and gets both folders in the same request.
    await addToGroup(alice, spaceId, family, bob);
    expect((await sharing.sharedWithMe(bob.ctx)).map((s) => s.share.shareId).sort()).toEqual(
      [first, other].sort(),
    );
    await spaceOperations.loadTree(bob.ctx, spaceId);
    expect((await pages.loadPage(bob.ctx, notes.pageId)).heads.draftHead).not.toBeNull();

    // The server refuses a removal that leaves his keys in either share.
    expect(await rejection(removeFromGroup(alice, spaceId, family, bob, { rotate: [first] }))).toBe(
      'stale-head',
    );
    expect((await removeFromGroup(alice, spaceId, family, bob)).sort()).toEqual(
      [first, other].sort(),
    );
    const shares = await sharing.listShares(alice.ctx, spaceId);
    expect(new Map(shares.map((s) => [s.shareId, s.currentKeyVersion]))).toEqual(
      new Map([
        [first, 2],
        [other, 2],
      ]),
    );

    const after = [
      (await pages.editDraft(alice.ctx, lib.page, { markdown: 'after Bob left' })).revisionId,
      (await pages.editDraft(alice.ctx, notes, { markdown: 'after Bob left too' })).revisionId,
    ];
    for (const call of [
      () => pages.loadPage(bob.ctx, lib.page.pageId),
      () => pages.loadPage(bob.ctx, notes.pageId),
      () => spaceOperations.loadTree(bob.ctx, spaceId),
      () => bob.api.call(sharingRoutes.myEnvelopes, { params: { spaceId } }),
    ]) {
      expect(await rejection(call())).toBe('not-found');
    }
    // His keys open what he could read before, and nothing saved since.
    const bobOpens = (await whatOpens(t, keysOf(bob))).revisions.map((r) => r.record.revisionId);
    expect(bobOpens.length).toBeGreaterThan(0);
    for (const revisionId of after) {
      expect(bobOpens).not.toContain(revisionId);
      expect(await opensWith(bob, revisionId)).toBe(false);
    }
    // Carol, still in the group, reads on, through version 2.
    const [, later] = after;
    if (!later) throw new Error('expected a draft');
    expect((await pages.loadPage(carol.ctx, notes.pageId)).heads.draftHead).toBe(later);
    const { opened } = await pages.openRevisionOf(carol.ctx, notes, 'draft', later);
    expect(opened).toMatchObject({ payload: { markdown: 'after Bob left too' } });
    expect(await opensWith(carol, later)).toBe(true);
  });

  it('leaves a member with a direct grant or another group their access, rotating nothing', async () => {
    const alice = await personWithVault(t);
    const [dave, erin] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId } = lib;
    const shareId = await shareFolder(alice.ctx, {
      spaceId,
      rootId: lib.shared,
      people: [await invite(alice, dave, 'editor')],
    });
    const family = await makeGroup(alice, spaceId, 'Family');
    const friends = await makeGroup(alice, spaceId, 'Friends');
    await addToGroup(alice, spaceId, family, dave);
    await addToGroup(alice, spaceId, family, erin);
    await addToGroup(alice, spaceId, friends, erin);
    const editors = { role: 'editor', canPublish: false } as const;
    await shareWithGroup(alice, {
      spaceId,
      shareId,
      groupId: family,
      access: editors,
      sealTo: [erin],
    });
    // Erin holds the editor keys already: Friends seals nothing.
    await shareWithGroup(alice, {
      spaceId,
      shareId,
      groupId: friends,
      access: editors,
      sealTo: [],
    });

    // Their roles don't change, so nothing rotates, and a rotation sent anyway is refused.
    expect(
      await rejection(removeFromGroup(alice, spaceId, family, dave, { rotate: [shareId] })),
    ).toBe('stale-head');
    expect(await removeFromGroup(alice, spaceId, family, dave)).toEqual([]);
    expect(await removeFromGroup(alice, spaceId, family, erin)).toEqual([]);
    const share = await shareOf(alice, spaceId);
    expect(share.currentKeyVersion).toBe(1);
    expect(new Map(share.members.map((m) => [m.identityId, m.role]))).toEqual(
      new Map([
        [dave.vault.identity.public.id, 'editor'],
        [erin.vault.identity.public.id, 'editor'],
      ]),
    );
    for (const person of [dave, erin]) {
      expect((await pages.loadPage(person.ctx, lib.page.pageId)).heads.draftHead).not.toBeNull();
    }
    // Once Erin leaves Friends too, nothing is left, and the share rotates without her.
    expect(await removeFromGroup(alice, spaceId, friends, erin)).toEqual([shareId]);
    expect(await rejection(pages.loadPage(erin.ctx, lib.page.pageId))).toBe('not-found');
  });

  it('serves a member waiting for keys nothing, until an owner gives them access', async () => {
    const alice = await personWithVault(t);
    const [frank, gina] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const lib = await library(alice);
    const { spaceId } = lib;
    const shareId = await shareFolder(alice.ctx, { spaceId, rootId: lib.shared, people: [] });
    const family = await makeGroup(alice, spaceId, 'Family');
    await addToGroup(alice, spaceId, family, frank);
    await addToGroup(alice, spaceId, family, gina);
    // Alice's app seals only to Gina, so Frank waits.
    await shareWithGroup(alice, {
      spaceId,
      shareId,
      groupId: family,
      access: { role: 'reader', canPublish: false },
      sealTo: [gina],
    });
    expect(await waitingIn(alice)).toEqual([
      { identityId: frank.vault.identity.public.id, shareId, role: 'reader' },
    ]);
    expect(await sharing.sharedWithMe(frank.ctx)).toEqual([]);
    for (const call of [
      () => spaceOperations.loadTree(frank.ctx, spaceId),
      () => pages.loadPage(frank.ctx, lib.page.pageId),
      () => frank.api.call(sharingRoutes.myEnvelopes, { params: { spaceId } }),
      () => frank.api.call(sharingRoutes.versionEnvelopes, { params: { shareId, keyVersion: 1 } }),
    ]) {
      expect(await rejection(call())).toBe('not-found');
    }
    const ids = (
      await t.db
        .select({ id: schema.revisions.id })
        .from(schema.revisions)
        .where(eq(schema.revisions.spaceId, spaceId))
    ).map((r) => RevisionId.parse(r.id));
    expect(ids.length).toBeGreaterThan(0);
    expect((await frank.api.call(pageRoutes.fetchRevisions, { body: { ids } })).revisions).toEqual(
      [],
    );
    const opens = await whatOpens(t, keysOf(frank));
    expect([opens.revisions, [...opens.names]]).toEqual([[], []]);
    expect((await pages.loadPage(gina.ctx, lib.page.pageId)).heads.publishedHead).not.toBeNull();

    await giveAccessTo(alice, spaceId, frank);
    expect(await waitingIn(alice)).toEqual([]);
    expect((await pages.loadPage(frank.ctx, lib.page.pageId)).heads.publishedHead).not.toBeNull();
  });
});
