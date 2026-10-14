// Records as a Milestone 1 app sealed them and a Milestone 1 server stored
// them: v1, with one envelope to the space's one owner. Today's server takes
// only v2 writes, so these go straight into the database.
import {
  MetadataRevisionId,
  newFolderMetadata,
  newId,
  newPayload,
  newSpaceMetadata,
  RevisionId,
  sealMetadata,
  SpaceId as SpaceIdSchema,
  type FolderId,
  type NodeMetadata,
  type PagePayload,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { sealAsMilestone1 } from '@wikistow/client/testing';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import type { TestApp } from './harness.ts';
import { ABOVE, library, SPACE, type Person } from './sharing.ts';

/**
 * A v1 draft of `page`, on top of its current draft, or a v1 publication of
 * its current draft, by `person`, sealed to them alone.
 */
export async function storeRevisionV1(
  t: TestApp,
  person: Person,
  page: { spaceId: SpaceId; pageId: PageId },
  { audience, payload }: { audience: 'draft' | 'published'; payload: PagePayload },
) {
  const [heads] = await t.db
    .select()
    .from(schema.pageHeads)
    .where(eq(schema.pageHeads.pageId, page.pageId));
  if (!heads) throw new Error('expected a page');
  const revisionId = newId(RevisionId);
  const basedOn = heads.draftHead === null ? null : RevisionId.parse(heads.draftHead);
  const { revision, envelopes } = sealAsMilestone1({
    author: person.ctx.identity,
    target: { installationId: person.ctx.installationId, ...page, revisionId, audience, basedOn },
    payload,
    recipients: [person.ctx.identity.public],
  });
  const draft = audience === 'draft';
  const draftSeq = heads.draftCount + 1;
  const publishedSeq = heads.publishedCount + 1;
  await t.db.insert(schema.revisions).values({
    id: revisionId,
    pageId: page.pageId,
    spaceId: page.spaceId,
    audience,
    basedOn,
    authorIdentityId: person.ctx.identity.public.id,
    authorKeyVersion: person.ctx.identity.public.keyVersion,
    authorAccountId: person.id,
    sealed: revision,
    payloadSize: revision.payload.ciphertext.length,
    draftSeq: draft ? draftSeq : null,
    publishedSeq: draft ? null : publishedSeq,
  });
  await t.db.insert(schema.keyEnvelopes).values(
    envelopes.map((envelope) => ({
      subjectKind: 'revision' as const,
      subjectId: revisionId,
      recipientIdentityId: envelope.recipientId,
      recipientKeyVersion: envelope.recipientKeyVersion,
      envelope,
    })),
  );
  await t.db
    .update(schema.pageHeads)
    .set(
      draft
        ? { draftHead: revisionId, draftCount: draftSeq }
        : { publishedHead: revisionId, publishedCount: publishedSeq },
    )
    .where(eq(schema.pageHeads.pageId, page.pageId));
  return revisionId;
}

/** A v1 version of a space's or folder's name, on top of its current one, by `person`. */
export async function storeNameV1(
  t: TestApp,
  person: Person,
  subject: { spaceId: SpaceId } & (
    | { subjectKind: 'space'; subjectId: SpaceId }
    | { subjectKind: 'folder'; subjectId: FolderId }
  ),
  metadata: NodeMetadata,
) {
  const [row] =
    subject.subjectKind === 'space'
      ? await t.db
          .select({ head: schema.spaces.metadataHead })
          .from(schema.spaces)
          .where(eq(schema.spaces.id, subject.spaceId))
      : await t.db
          .select({ head: schema.nodes.metadataHead })
          .from(schema.nodes)
          .where(eq(schema.nodes.id, subject.subjectId));
  const metadataRevisionId = newId(MetadataRevisionId);
  const basedOn = row?.head ? MetadataRevisionId.parse(row.head) : null;
  const { metadata: sealed, envelopes } = sealMetadata({
    author: person.ctx.identity,
    target: {
      installationId: person.ctx.installationId,
      ...subject,
      metadataRevisionId,
      basedOn,
    },
    metadata,
    recipients: [person.ctx.identity.public],
  });
  await t.db.insert(schema.metadataRevisions).values({
    id: metadataRevisionId,
    ...subject,
    basedOn,
    authorIdentityId: person.ctx.identity.public.id,
    authorKeyVersion: person.ctx.identity.public.keyVersion,
    sealed,
  });
  await t.db.insert(schema.keyEnvelopes).values(
    envelopes.map((envelope) => ({
      subjectKind: 'metadata' as const,
      subjectId: metadataRevisionId,
      recipientIdentityId: envelope.recipientId,
      recipientKeyVersion: envelope.recipientKeyVersion,
      envelope,
    })),
  );
  if (subject.subjectKind === 'space') {
    await t.db
      .update(schema.spaces)
      .set({ metadataHead: metadataRevisionId })
      .where(eq(schema.spaces.id, subject.spaceId));
  } else {
    await t.db
      .update(schema.nodes)
      .set({ metadataHead: metadataRevisionId })
      .where(eq(schema.nodes.id, subject.subjectId));
  }
  return metadataRevisionId;
}

/**
 * A space as a Milestone 1 app made it: its first name record v1, sealed to
 * its one owner, who is the space's owner on the server.
 */
async function milestone1Space(t: TestApp, owner: Person, name: string) {
  const spaceId = newId(SpaceIdSchema);
  // A space always has an owner, checked when the transaction commits.
  await t.db.transaction(async (tx) => {
    await tx.insert(schema.spaces).values({ id: spaceId, kind: 'personal', createdBy: owner.id });
    await tx
      .insert(schema.spaceOwners)
      .values({ spaceId, identityId: owner.vault.identity.public.id, addedBy: owner.id });
  });
  await storeNameV1(
    t,
    owner,
    { spaceId, subjectKind: 'space', subjectId: spaceId },
    newSpaceMetadata(name),
  );
  return spaceId;
}

/**
 * `library` in a Milestone 1 space, with every current version as a
 * Milestone 1 app last wrote it: the space's and both folders' names, the
 * shared page's draft and its publication, and the private page's draft,
 * all v1.
 */
export async function milestone1Library(t: TestApp, owner: Person) {
  const lib = await library(owner, await milestone1Space(t, owner, SPACE));
  const { spaceId } = lib;
  await storeNameV1(
    t,
    owner,
    { spaceId, subjectKind: 'folder', subjectId: lib.above },
    newFolderMetadata(ABOVE),
  );
  await storeNameV1(
    t,
    owner,
    { spaceId, subjectKind: 'folder', subjectId: lib.shared },
    newFolderMetadata('Shared (M1)'),
  );
  const payload = (markdown: string) => newPayload({ title: 'Plan', markdown });
  const v1 = {
    draft: await storeRevisionV1(t, owner, lib.page, {
      audience: 'draft',
      payload: payload('M1 draft words'),
    }),
    published: await storeRevisionV1(t, owner, lib.page, {
      audience: 'published',
      payload: payload('M1 published words'),
    }),
    private: await storeRevisionV1(t, owner, lib.beside, {
      audience: 'draft',
      payload: newPayload({ title: 'Private', markdown: 'M1 private words' }),
    }),
  };
  return { ...lib, v1 };
}
