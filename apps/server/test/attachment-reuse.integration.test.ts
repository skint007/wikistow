// Publishing lists an earlier copy of an attachment only while its bytes
// are still the draft's (protocol section 12, #18).
import {
  aeadEncrypt,
  canonical,
  hash,
  newId,
  pageOperations as pages,
  plainHash,
  RevisionId,
  sealedBytes,
  sealRevisionV2,
  toBase64,
  utf8,
  type AttachmentRef,
  type PagePayload,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import { pageRoutes, type Audience } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { draftHead, invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function payloadOf(person: Person, page: pages.PageRef, audience: Audience, id: RevisionId) {
  const { opened } = await pages.openRevisionOf(person.ctx, page, audience, id);
  if (opened.kind !== 'current') throw new Error('expected the current format');
  return opened.payload;
}

const attachmentOf = async (
  person: Person,
  page: pages.PageRef,
  audience: Audience,
  id: RevisionId,
) => {
  const [ref] = (await payloadOf(person, page, audience, id)).attachments;
  if (!ref) throw new Error('expected an attachment');
  return ref;
};

/**
 * A copy of attachment `id` holding `bytes`, sealed for the page's
 * published audience as any publisher could seal one.
 */
function copyOf(person: Person, page: pages.PageRef, ref: AttachmentRef, bytes: Uint8Array) {
  const target = { installationId: person.ctx.installationId, ...page };
  const key = crypto.getRandomValues(new Uint8Array(32));
  const ad = canonical('attachment/v1', [
    target.installationId,
    page.spaceId,
    page.pageId,
    'published',
    ref.id,
  ]);
  const blob = sealedBytes(aeadEncrypt({ key, plaintext: bytes, ad }));
  return {
    ref: {
      ...ref,
      size: bytes.length,
      key: toBase64(key),
      blobHash: hash(blob),
      plainHash: plainHash(target, bytes),
    },
    blob,
  };
}

/** A publication of the current draft, with `payload` as its publisher wrote it. */
async function publishAs(
  person: Person,
  page: pages.PageRef,
  payload: PagePayload,
  blob: Uint8Array,
) {
  await person.api.upload(
    `/api/pages/${page.pageId}/blobs?audience=published`,
    blob,
    pageRoutes.BlobUploadResult,
  );
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  const { permissionVersion, keyTarget } = await writeTargetOf(
    person.ctx,
    page.spaceId,
    page.pageId,
  );
  await person.api.call(pageRoutes.publish, {
    params: { pageId: page.pageId },
    body: {
      ...sealRevisionV2({
        author: person.ctx.identity,
        target: {
          installationId: person.ctx.installationId,
          ...page,
          revisionId: newId(RevisionId),
          audience: 'published',
          basedOn: heads.draftHead,
        },
        payload,
        ...keyTarget,
      }),
      blobRefs: payload.attachments.map((ref) => ref.blobHash),
      permissionVersion,
      expectedPublishedHead: heads.publishedHead,
    },
  });
}

/** A shared folder whose page lists one attachment, published once. */
async function world() {
  const [alice, bob, carol] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(alice);
  await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, 'editor', true), await invite(alice, carol, 'reader')],
  });
  const { page } = lib;
  const map = await pages.uploadAttachment(alice.ctx, page, {
    name: 'map.txt',
    mediaType: 'text/plain',
    bytes: utf8('the real map'),
  });
  await pages.editDraft(alice.ctx, page, { attachments: [map] });
  const { revisionId: first } = await pages.publishPage(alice.ctx, page);
  return { alice, bob, carol, page, map, first };
}

describe('publishing again', () => {
  it('lists the last copy while its plaintext hash matches, and reseals otherwise', async () => {
    const { alice, bob, carol, page, map, first } = await world();
    const original = await attachmentOf(alice, page, 'published', first);
    expect(original.plainHash).toBe(map.plainHash);
    await pages.editDraft(alice.ctx, page, { markdown: 'edited' });
    const { revisionId: second } = await pages.publishPage(alice.ctx, page);
    expect((await attachmentOf(alice, page, 'published', second)).blobHash).toBe(original.blobHash);

    // Bob publishes a copy of the map with other bytes, under their own hash.
    // Alice's publication after it doesn't carry it: it seals the draft's bytes again.
    const draft = await payloadOf(bob, page, 'draft', await draftHead(bob, page));
    const copy = copyOf(bob, page, original, utf8('a false map'));
    await publishAs(bob, page, { ...draft, attachments: [copy.ref] }, copy.blob);
    const { revisionId } = await pages.publishPage(alice.ctx, page);
    const fresh = await attachmentOf(alice, page, 'published', revisionId);
    expect([original.blobHash, copy.ref.blobHash]).not.toContain(fresh.blobHash);
    expect(fresh.plainHash).toBe(map.plainHash);
    expect(text(await pages.readAttachment(carol.ctx, page, 'published', fresh))).toBe(
      'the real map',
    );
  });
});
