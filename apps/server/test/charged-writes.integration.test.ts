// Writes that charge storage queue on their person's account before they
// hold anything a change of access waits on (#439): one person's writes
// on several pages at once can't hold off their own removal.
import {
  newId,
  pageOperations as pages,
  publicLinkOperations as links,
  sharingOperations as sharing,
  spaceOperations as spaces,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { AttachmentId, copyRoutes, publicLinkRoutes } from '@wikistow/contracts';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { commentSealer, sendComment } from './support/comments.ts';
import { personWithVault } from './support/content.ts';
import { openCopy } from './support/copies.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.drop();
});

type Page = { spaceId: SpaceId; pageId: PageId };

/** A library whose `Shared` folder has an editor who can publish, and four pages in it. */
async function sharedPages() {
  const [owner, editor] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const lib = await library(owner);
  const shareId = await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, editor, 'editor', true)],
  });
  const list: Page[] = [lib.page];
  for (let i = 1; i < 4; i++) {
    list.push({
      spaceId: lib.spaceId,
      pageId: await pages.createPage(owner.ctx, {
        spaceId: lib.spaceId,
        parentId: lib.shared,
        title: `Page ${i}`,
        markdown: 'x',
      }),
    });
  }
  return { owner, editor, lib, shareId, list };
}

async function folderNow(person: Person, spaceId: SpaceId, folderId: FolderId) {
  const { folders } = await spaces.loadStructure(person.ctx, spaceId);
  const metadata = folders.find((folder) => folder.id === folderId)?.metadata;
  if (!metadata) throw new Error('no folder');
  return metadata;
}

type Setup = Awaited<ReturnType<typeof sharedPages>>;
/** A write the editor sends again and again, given its turn. */
type Write = (i: number) => Promise<unknown>;

/** Saves on `page`, each on top of the last as typing saves, with no page opened between. */
async function draftSaves({ editor }: Setup, page: Page): Promise<Write> {
  let last = await pages.editDraft(editor.ctx, page, { markdown: 'n' });
  return async (i) => {
    last = await pages.saveDraft(editor.ctx, {
      page,
      basedOn: last.revisionId,
      basedOnRegion: last.region,
      payload: { ...last.payload, markdown: `n${i}` },
    });
  };
}

async function comments({ editor }: Setup, page: Page): Promise<Write> {
  const seal = await commentSealer(editor.ctx, page);
  return (i) => sendComment(editor.ctx, page.pageId, seal({ audience: 'draft', text: `c${i}` }));
}

/** Names of a folder made beside `page`. */
async function folderNames({ owner, editor, lib }: Setup, page: Page): Promise<Write> {
  const folderId = await spaces.createFolder(owner.ctx, {
    spaceId: lib.spaceId,
    parentId: lib.shared,
    name: `Beside ${page.pageId}`,
  });
  let current = await folderNow(editor, lib.spaceId, folderId);
  return async (i) => {
    current = await spaces.updateMetadata(editor.ctx, {
      spaceId: lib.spaceId,
      subject: { kind: 'folder', folderId },
      current,
      changes: { name: `Folder ${i}` },
    });
  };
}

/** Bytes as an attachment's blob is to the server: new each time, never read. */
async function attachments({ editor }: Setup, page: Page): Promise<Write> {
  return () => pages.uploadBlob(editor.ctx, page, 'draft', randomBytes(64));
}

/** A copy of `page` beside it, its records sent again and again, each charged again. */
async function copyRecords({ editor, lib }: Setup, page: Page): Promise<Write> {
  const copy = await openCopy(editor.ctx, {
    from: lib.spaceId,
    nodeId: page.pageId,
    to: lib.spaceId,
    parentId: lib.shared,
    published: false,
  });
  await copy.open();
  const body = { nodes: [await copy.seal(page.pageId)] };
  return () => editor.ctx.api.call(copyRoutes.records, { params: { copyId: copy.copyId }, body });
}

/** A staged public copy of `page` whose one file is uploaded again and again. */
async function copyFiles({ editor }: Setup, page: Page): Promise<Write> {
  await pages.publishPage(editor.ctx, page);
  await links.turnOn(editor.ctx, page.pageId);
  const { publishedHead } = (await pages.loadPage(editor.ctx, page.pageId)).heads;
  if (!publishedHead) throw new Error('not published');
  const attachmentId = newId(AttachmentId);
  const { copyId, files } = await editor.ctx.api.call(publicLinkRoutes.stage, {
    params: { pageId: page.pageId },
    body: {
      revisionId: publishedHead,
      title: 'Page',
      markdown: `![](attachment:${attachmentId})\n`,
      attachments: [{ id: attachmentId, name: 'a.png', mediaType: 'image/png', size: 64 }],
      targets: [],
    },
  });
  expect(files).toEqual([attachmentId]);
  const path = publicLinkRoutes.FILE_UPLOAD_PATH.replace(':copyId', copyId).replace(
    ':attachmentId',
    attachmentId,
  );
  return () => editor.ctx.api.upload(path, randomBytes(64), publicLinkRoutes.FileUploadResult);
}

type Writes = (setup: Setup, page: Page) => Promise<Write>;
const fourOf = (writes: Writes) => [writes, writes, writes, writes];

/**
 * What the editor sends on each of the four pages at once. A person's
 * uploads and copy records take the one large body the server reads of
 * theirs at a time, so they can't overlap alone: each goes beside saves.
 */
const floods: Record<string, Writes[]> = {
  'draft saves': fourOf(draftSaves),
  comments: fourOf(comments),
  'folder names': fourOf(folderNames),
  'attachments beside saves': [attachments, draftSaves, draftSaves, draftSaves],
  'copy records beside saves': [copyRecords, draftSaves, draftSaves, draftSaves],
  'public copy files beside saves': [copyFiles, draftSaves, draftSaves, draftSaves],
};

describe('a removal while one person floods charged writes on four pages', () => {
  it.each(Object.keys(floods))(
    'goes through promptly (%s)',
    async (kind) => {
      const setup = await sharedPages();
      const { owner, editor, lib, shareId } = setup;
      const writes: Write[] = [];
      // One at a time: the large ones can't be set up at once either.
      for (const [i, make] of (floods[kind] ?? []).entries()) {
        writes.push(await make(setup, setup.list[i] as Page));
      }
      let flooding = true;
      const landed = writes.map(() => 0);
      const loops = writes.map(async (write, n) => {
        for (let i = 0; flooding; i++) {
          await write(i).then(
            () => (landed[n] = (landed[n] ?? 0) + 1),
            () => {},
          );
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Every kind of write was landing when the removal began.
      const before = [...landed];
      const began = Date.now();
      const removed = sharing.removeMember(owner.ctx, {
        spaceId: lib.spaceId,
        shareId,
        identityId: editor.vault.identity.public.id,
      });
      const took = await Promise.race([
        removed.then(() => Date.now() - began),
        new Promise<null>((resolve) => setTimeout(resolve, 10_000, null)),
      ]);
      flooding = false;
      await Promise.all(loops);
      await removed;
      expect(before.every((count) => count > 0)).toBe(true);
      // Unqueued, the removal waited for as long as the flood ran.
      expect(took).not.toBeNull();
      expect(took).toBeLessThan(3000);
    },
    30_000,
  );
});
