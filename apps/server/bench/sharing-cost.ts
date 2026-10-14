// The sharing-cost benchmark (protocol section 17, Q8): a family-sized
// library, then the owner actions that touch every record or member, timed
// through the real client operations against the real server. Run with
// the `bench` project, and only when WIKISTOW_BENCH names a file, where the
// timings are written as JSON (wikistow/benchmarks/sharing.md reports them).
import {
  newId,
  newPayload,
  ownerOperations as owners,
  PageId,
  publicationOperations as pubs,
  RevisionId,
  sealAttachment,
  sealRevisionV2,
  pageOperations as pages,
  sharingOperations as sharing,
  spaceOperations,
  type AttachmentRef,
  type FolderId,
  type SpaceId,
} from '@wikistow/client';
import { schema } from '@wikistow/server';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from '../test/support/content.ts';
import { createTestApp, type TestApp } from '../test/support/harness.ts';
import { find, shareFolder, type Person } from '../test/support/sharing.ts';

const BENCH = process.env['WIKISTOW_BENCH'] ?? '';

const SPACES = 5;
const PAGES = 2000;
const VERSIONS = 20;
// Of each page's versions, this many are publications, each based on the draft before it.
const PUBLISHED = 5;
const ATTACHMENTS = 500;
const MEMBERS = 10;
const FOLDERS_PER_SPACE = 8;

let t: TestApp;
beforeAll(async () => {
  if (BENCH) t = await createTestApp();
});
afterAll(() => (BENCH ? t.drop() : undefined));

/** About two kilobytes of Markdown, as a page of family notes runs. */
const BODY = 'Remember to water the plants and check the boiler. '.repeat(40);

/**
 * Store a page's whole history at once, as its owner's app would have
 * written it over time: real v2 records sealed to the owner, so sharing
 * works on them as on any other.
 */
async function seedPage(
  owner: Person,
  {
    spaceId,
    parentId,
    attachments,
  }: { spaceId: SpaceId; parentId: FolderId; attachments: AttachmentRef[] },
) {
  const pageId = newId(PageId);
  await t.db.insert(schema.nodes).values({ id: pageId, spaceId, parentId, kind: 'page' });
  const revisionRows: (typeof schema.revisions.$inferInsert)[] = [];
  const envelopeRows: (typeof schema.keyEnvelopes.$inferInsert)[] = [];
  let draft: RevisionId | null = null;
  let published: RevisionId | null = null;
  let drafts = 0;
  let publications = 0;
  const publishEvery = Math.floor(VERSIONS / PUBLISHED);
  for (let i = 0; i < VERSIONS; i++) {
    const audience = (i + 1) % publishEvery === 0 && draft ? 'published' : 'draft';
    const revisionId = newId(RevisionId);
    const { revision, envelopes } = sealRevisionV2({
      author: owner.ctx.identity,
      target: {
        installationId: owner.ctx.installationId,
        spaceId,
        pageId,
        revisionId,
        audience,
        basedOn: draft,
      },
      payload: newPayload({ title: `Page ${pageId}`, markdown: `${BODY} ${i}`, attachments }),
      recipients: [owner.ctx.identity.public],
    });
    revisionRows.push({
      id: revisionId,
      pageId,
      spaceId,
      audience,
      basedOn: draft,
      authorIdentityId: owner.ctx.identity.public.id,
      authorKeyVersion: owner.ctx.identity.public.keyVersion,
      authorAccountId: owner.id,
      sealed: revision,
      payloadSize: revision.payload.ciphertext.length,
      ...(audience === 'draft' ? { draftSeq: ++drafts } : { publishedSeq: ++publications }),
    });
    envelopeRows.push(
      ...envelopes.map((envelope) => ({
        subjectKind: 'revision' as const,
        subjectId: revisionId,
        recipientIdentityId: envelope.recipientId,
        recipientKeyVersion: envelope.recipientKeyVersion,
        envelope,
      })),
    );
    if (audience === 'draft') draft = revisionId;
    else published = revisionId;
  }
  return {
    revisionRows,
    envelopeRows,
    heads: {
      pageId,
      draftHead: draft,
      publishedHead: published,
      draftCount: drafts,
      publishedCount: publications,
    },
  };
}

async function seedLibrary(owner: Person) {
  // Each space, with a page that carries no attachment, to publish elsewhere.
  const spaces: { spaceId: SpaceId; plainPage: PageId }[] = [];
  let attachmentsLeft = ATTACHMENTS;
  for (let s = 0; s < SPACES; s++) {
    const spaceId = await spaceOperations.createSpace(owner.ctx, { name: `Space ${s}` });
    const folders: FolderId[] = [];
    for (let f = 0; f < FOLDERS_PER_SPACE; f++) {
      folders.push(
        await spaceOperations.createFolder(owner.ctx, {
          spaceId,
          parentId: null,
          name: `Folder ${f}`,
        }),
      );
    }
    let plainPage: PageId | null = null;
    for (let p = 0; p < PAGES / SPACES; p++) {
      // Every fourth page carries one attachment, until all are placed.
      const attachments =
        p % 4 === 0 && attachmentsLeft-- > 0
          ? [
              sealAttachment({
                target: {
                  installationId: owner.ctx.installationId,
                  spaceId,
                  pageId: newId(PageId),
                  audience: 'draft',
                },
                name: `photo-${p}.jpg`,
                mediaType: 'image/jpeg',
                bytes: new Uint8Array(64),
              }).ref,
            ]
          : [];
      const seeded = await seedPage(owner, {
        spaceId,
        parentId: folders[p % folders.length] as FolderId,
        attachments,
      });
      await t.db.insert(schema.revisions).values(seeded.revisionRows);
      await t.db.insert(schema.keyEnvelopes).values(seeded.envelopeRows);
      await t.db.insert(schema.pageHeads).values(seeded.heads);
      if (attachments.length === 0) plainPage ??= seeded.heads.pageId;
    }
    if (!plainPage) throw new Error('expected a page without attachments');
    spaces.push({ spaceId, plainPage });
  }
  return spaces;
}

/** Run `action` and return how long it took, in milliseconds, with the request bytes it sent. */
async function timed<T>(owner: Person, action: () => Promise<T>) {
  let sent = 0;
  const call = owner.ctx.api.call;
  owner.ctx.api.call = ((route, ...args) => {
    const [input] = args as [{ body?: unknown } | undefined, ...unknown[]];
    if (input?.body !== undefined) sent += JSON.stringify(input.body).length;
    return call(route, ...args);
  }) as typeof call;
  const started = performance.now();
  try {
    const result = await action();
    return { ms: Math.round(performance.now() - started), sent, result };
  } finally {
    owner.ctx.api.call = call;
  }
}

describe.skipIf(!BENCH)('the sharing cost of a family library', () => {
  it(
    `shares ${SPACES} spaces of ${PAGES} pages, ${VERSIONS} versions each, with ${MEMBERS} people`,
    { timeout: 3 * 60 * 60 * 1000 },
    async () => {
      const owner = await personWithVault(t);
      const people: Person[] = [];
      for (let i = 0; i < MEMBERS; i++) people.push(await personWithVault(t));
      const seedStarted = performance.now();
      const library = await seedLibrary(owner);
      const seedMs = Math.round(performance.now() - seedStarted);
      const lookups = await Promise.all(people.map((person) => find(owner, person)));
      const invitees = lookups.slice(0, MEMBERS - 1).map((person, i) => ({
        person,
        role: i % 3 === 0 ? ('reader' as const) : ('editor' as const),
      }));
      const results: Record<string, number | string>[] = [];

      // A co-owner of the last space before it is shared: every record of the
      // space is in the owner region, so each gets an envelope.
      const coOwner = await personWithVault(t);
      const lastSpace = library.at(-1);
      if (!lastSpace) throw new Error('expected a space');
      const coOwnerAdd = await timed(owner, async () =>
        owners.addCoOwner(owner.ctx, {
          spaceId: lastSpace.spaceId,
          person: await find(owner, coOwner),
        }),
      );

      for (const [index, { spaceId }] of library.entries()) {
        const share = await timed(owner, () =>
          shareFolder(owner.ctx, { spaceId, rootId: null, people: invitees }),
        );
        const shareId = share.result;
        const last = lookups[MEMBERS - 1];
        if (!last) throw new Error('expected a tenth person');
        const add = await timed(owner, () =>
          sharing.addMember(owner.ctx, { spaceId, shareId, person: last, role: 'editor' }),
        );
        const removed = people[0]?.vault.identity.public.id;
        if (!removed) throw new Error('expected a member');
        const remove = await timed(owner, () =>
          sharing.removeMember(owner.ctx, { spaceId, shareId, identityId: removed }),
        );
        results.push({
          space: index,
          records: (PAGES / SPACES) * VERSIONS + FOLDERS_PER_SPACE + 1,
          shareMs: share.ms,
          shareBytes: share.sent,
          addMemberMs: add.ms,
          addMemberBytes: add.sent,
          removeMs: remove.ms,
          removeBytes: remove.sent,
        });
      }

      // Publishing one page of each space into the next one, after all are
      // shared: a copy of one version, whatever the library's size.
      const publications: Record<string, number>[] = [];
      for (const [index, { spaceId, plainPage }] of library.entries()) {
        const destination = library[(index + 1) % library.length];
        if (!destination) throw new Error('expected a space');
        const source = { spaceId, pageId: plainPage };
        const { heads } = await pages.loadPage(owner.ctx, plainPage);
        if (!heads.publishedHead) throw new Error('expected a publication');
        const revisionId = heads.publishedHead;
        const publish = await timed(owner, async () =>
          pubs.publishToSpace(owner.ctx, {
            preview: await pubs.previewPublication(owner.ctx, {
              source,
              revisionId,
              audience: 'published',
              spaceId: destination.spaceId,
              parentId: null,
            }),
            attachmentIds: new Set(),
          }),
        );
        publications.push({ space: index, publishMs: publish.ms, publishBytes: publish.sent });
      }

      await writeFile(
        BENCH,
        JSON.stringify({
          seedMs,
          results,
          publications,
          addCoOwnerMs: coOwnerAdd.ms,
          addCoOwnerBytes: coOwnerAdd.sent,
        }),
      );
      expect(results).toHaveLength(SPACES);
    },
  );
});
