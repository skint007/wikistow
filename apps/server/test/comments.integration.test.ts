// The comments server (protocol section 5.9, ADR 0014 step 2): who is
// served and may write which comments, and how comments' keys follow their
// page through the owner operations that cover a subtree.
import {
  endingOperations as ending,
  moveOperations as moves,
  newFolderMetadata,
  ownerOperations as owners,
  pageOperations as pages,
  sealMetadataV2,
  trashOperations as trash,
  type ClientContext,
  type FolderId,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import {
  commentRoutes,
  MetadataRevisionId,
  ShareId,
  structureRoutes,
  type CommentId,
} from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  handlingComments,
  postComment,
  sealComment,
  sendComment,
  textOf,
  threadsOf,
} from './support/comments.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { find, invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A library whose `Shared` folder has a reader and an editor. */
async function sharedLibrary() {
  const [owner, reader, editor] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(owner);
  await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, reader, 'reader'), await invite(owner, editor, 'editor')],
  });
  return { owner, reader, editor, lib };
}

const authorOf = (person: Person) => person.vault.identity.public.id;

describe('readers and editors', () => {
  it('serve readers no comment for editors, and refuse them one', async () => {
    const { reader, editor, lib } = await sharedLibrary();
    const notes = await postComment(editor.ctx, lib.page, {
      audience: 'draft',
      text: 'Shall we drop the part about Gran?',
    });
    const question = await postComment(reader.ctx, lib.page, {
      audience: 'published',
      text: 'Fan oven or not?',
    });
    await postComment(editor.ctx, lib.page, {
      audience: 'published',
      text: 'Fan: 170 °C.',
      thread: question.commentId,
      threadAuthor: authorOf(reader),
    });

    const seen = await threadsOf(reader.ctx, lib.page.pageId);
    expect(seen.threads.map((thread) => thread.thread)).toEqual([question.commentId]);
    const [thread] = seen.threads;
    if (!thread?.first.sealed || !thread.replies[0]?.sealed) throw new Error('expected a thread');
    expect(await textOf(reader.ctx, thread.first.sealed, 'published')).toBe('Fan oven or not?');
    expect(await textOf(reader.ctx, thread.replies[0].sealed, 'published')).toBe('Fan: 170 °C.');
    // Editors see both.
    const all = await threadsOf(editor.ctx, lib.page.pageId);
    expect(all.threads.map((each) => each.audience)).toEqual(['draft', 'published']);

    // A reader holds no draft key, and may not write for editors anyway.
    const sealed = await sealComment(reader.ctx, lib.page, { audience: 'published', text: 'x' });
    expect(
      await rejection(sendComment(reader.ctx, lib.page.pageId, sealed, { audience: 'draft' })),
    ).toBe('forbidden');
    // Nor answer an editors' thread, which isn't there for them.
    const reply = await sealComment(reader.ctx, lib.page, {
      audience: 'published',
      text: 'a reply',
      thread: notes.commentId,
      threadAuthor: authorOf(editor),
    });
    expect(
      await rejection(sendComment(reader.ctx, lib.page.pageId, reply, { thread: notes.commentId })),
    ).toBe('not-found');
  });

  it('refuse a reply in the wrong audience or thread, and IDs taken', async () => {
    const { owner, reader, editor, lib } = await sharedLibrary();
    const question = await postComment(reader.ctx, lib.page, {
      audience: 'published',
      text: 'question',
    });
    const answer = await postComment(editor.ctx, lib.page, {
      audience: 'published',
      text: 'answer',
      thread: question.commentId,
      threadAuthor: authorOf(reader),
    });
    const reply = async (audience: 'draft' | 'published', thread: CommentId) =>
      rejection(
        sendComment(
          editor.ctx,
          lib.page.pageId,
          await sealComment(editor.ctx, lib.page, {
            audience,
            text: 'reply',
            thread,
            threadAuthor: authorOf(reader),
          }),
          { thread },
        ),
      );
    // For editors, under a thread for readers.
    expect(await reply('draft', question.commentId)).toBe('binding-mismatch');
    // Under a reply: threads have one level.
    expect(await reply('published', answer.commentId)).toBe('not-found');
    // Under a thread on another page.
    const elsewhere = await postComment(owner.ctx, lib.beside, { audience: 'draft', text: 'y' });
    expect(await reply('draft', elsewhere.commentId)).toBe('not-found');

    // A request naming another comment than its record.
    const first = await sealComment(editor.ctx, lib.page, { audience: 'draft', text: 'z' });
    expect(
      await rejection(
        sendComment(editor.ctx, lib.page.pageId, first, { commentId: question.commentId }),
      ),
    ).toBe('invalid-request');
    // The same request again, as after a lost answer.
    await sendComment(editor.ctx, lib.page.pageId, first);
    expect(await rejection(sendComment(editor.ctx, lib.page.pageId, first))).toBe('duplicate');

    // Comment and metadata versions are one set of IDs, both ways.
    const head = async (folderId: FolderId) => {
      const [folder] = await t.db
        .select({ head: schema.nodes.metadataHead })
        .from(schema.nodes)
        .where(eq(schema.nodes.id, folderId));
      if (!folder?.head) throw new Error('expected a name');
      return MetadataRevisionId.parse(folder.head);
    };
    const named = await head(lib.shared);
    const onName = await sealComment(editor.ctx, lib.page, {
      audience: 'draft',
      text: 'w',
      versionId: named,
    });
    expect(await rejection(sendComment(editor.ctx, lib.page.pageId, onName))).toBe('duplicate');
    const { permissionVersion, keyTarget } = await writeTargetOf(
      owner.ctx,
      lib.spaceId,
      lib.shared,
    );
    const rename = sealMetadataV2({
      author: owner.ctx.identity,
      target: {
        installationId: owner.ctx.installationId,
        spaceId: lib.spaceId,
        subjectKind: 'folder',
        subjectId: lib.shared,
        metadataRevisionId: first.comment.versionId,
        basedOn: named,
      },
      metadata: newFolderMetadata('Renamed'),
      ...keyTarget,
    });
    expect(
      await rejection(
        owner.ctx.api.call(structureRoutes.updateMetadata, {
          params: { spaceId: lib.spaceId },
          body: { ...rename, permissionVersion },
        }),
      ),
    ).toBe('duplicate');
  });
});

describe('the owner operations that cover a subtree', () => {
  it('are refused without the comments’ key material, and carry it when given', async () => {
    const [owner, reader, bob] = await Promise.all([
      personWithVault(t),
      personWithVault(t),
      personWithVault(t),
    ]);
    const lib = await library(owner);
    const { spaceId } = lib;
    // In the owner region, sealed to the owner.
    const forReaders = await postComment(owner.ctx, lib.page, {
      audience: 'published',
      text: 'for readers',
    });
    const forEditors = await postComment(owner.ctx, lib.page, {
      audience: 'draft',
      text: 'for editors',
    });
    const both = [forReaders, forEditors];
    // An app from before comments; one that asks for them and leaves them
    // out of its request; and one that carries them.
    const older = (ctx: ClientContext) => ctx;
    const forgets = (ctx: ClientContext) => handlingComments(ctx, both, { send: false });
    const carries = (ctx: ClientContext) => handlingComments(ctx, both);
    const refusals = async (operation: (ctx: ClientContext) => Promise<unknown>) => [
      await rejection(operation(older(owner.ctx))),
      await rejection(operation(forgets(owner.ctx))),
    ];
    const texts = async (person: Person) =>
      Promise.all(
        (await threadsOf(person.ctx, lib.page.pageId)).threads.map(async ({ first, audience }) => {
          if (!first.sealed) throw new Error('expected the comment');
          return textOf(person.ctx, first.sealed, audience);
        }),
      );

    // Making a share wraps each by its audience.
    const people = [await invite(owner, reader, 'reader')];
    const share = (ctx: ClientContext) => shareFolder(ctx, { spaceId, rootId: lib.shared, people });
    expect(await refusals(share)).toEqual(['invalid-request', 'stale-head']);
    await share(carries(owner.ctx));
    expect(await texts(reader)).toEqual(['for readers']);
    const [made] = await t.db
      .select({ id: schema.shares.id })
      .from(schema.shares)
      .where(eq(schema.shares.rootId, lib.shared));
    if (!made) throw new Error('expected the share');

    // A move out of the share seals them to the owners; back in, wraps them.
    const move = (parentId: FolderId | null) => async (ctx: ClientContext) =>
      moves.moveNode(ctx, {
        preview: await moves.previewMove(ctx, { spaceId, nodeId: lib.page.pageId, parentId }),
      });
    expect(await refusals(move(lib.above))).toEqual(['invalid-request', 'stale-head']);
    await move(lib.above)(carries(owner.ctx));
    expect(await texts(owner)).toEqual(['for readers', 'for editors']);
    expect(await rejection(threadsOf(reader.ctx, lib.page.pageId))).toBe('not-found');
    await move(lib.shared)(carries(owner.ctx));
    expect(await texts(reader)).toEqual(['for readers']);

    // Ending the share seals them to the owners.
    const end = async (ctx: ClientContext) =>
      ending.endShare(ctx, {
        preview: await ending.previewEnding(ctx, { spaceId, shareId: ShareId.parse(made.id) }),
      });
    expect(await refusals(end)).toEqual(['invalid-request', 'stale-head']);
    await end(carries(owner.ctx));
    expect(await texts(owner)).toEqual(['for readers', 'for editors']);

    // Adding a co-owner seals them to the new owner too.
    const person = await find(owner, bob);
    const add = (ctx: ClientContext) => owners.addCoOwner(ctx, { spaceId, person });
    expect(await refusals(add)).toEqual(['invalid-request', 'stale-head']);
    await add(handlingComments(owner.ctx, both, { newOwner: bob.ctx.identity.public }));
    const adder = await owners.ownerToConfirm(bob.ctx, spaceId);
    if (!adder) throw new Error('expected the co-owner dialog');
    await owners.confirmOwner(bob.ctx, { spaceId, adder });
    expect(await texts(bob)).toEqual(['for readers', 'for editors']);
  });
});

describe('the trash', () => {
  it('hides a page’s comments with it, and deleting it for good takes them', async () => {
    const owner = await personWithVault(t);
    const lib = await library(owner);
    const page = lib.beside;
    const binned = await postComment(owner.ctx, page, { audience: 'draft', text: 'binned' });
    await postComment(owner.ctx, page, { audience: 'draft', text: 'kept a while' });
    const trashed = async () => {
      await pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: page.pageId });
      const entry = (await trash.loadTrash(owner.ctx)).find((item) => item.nodeId === page.pageId);
      if (!entry) throw new Error('expected it in the trash');
      return entry.trashId;
    };

    await trash.restoreTrash(owner.ctx, await trashed());
    expect((await threadsOf(owner.ctx, page.pageId)).threads).toHaveLength(2);
    const trashId = await trashed();
    expect(await rejection(threadsOf(owner.ctx, page.pageId))).toBe('not-found');
    expect(await rejection(postComment(owner.ctx, page, { audience: 'draft', text: 'x' }))).toBe(
      'not-found',
    );
    // An owner deletes a comment there; deleting the page for good takes the rest.
    await owner.ctx.api.call(commentRoutes.deleteComment, {
      params: { commentId: binned.commentId },
    });
    const left = () =>
      t.db
        .select({ id: schema.comments.id })
        .from(schema.comments)
        .where(eq(schema.comments.pageId, page.pageId));
    expect(await left()).toHaveLength(1);
    await trash.purgeTrash(owner.ctx, trashId);
    expect(await left()).toEqual([]);
  });
});
