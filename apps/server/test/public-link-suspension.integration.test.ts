// Ending a public link while its people are suspended (#679). Suspension
// holds the account's row, then its links and copies. A change that ends a
// link and then records it under that account's name must take the account's
// row first too, or each waits on what the other holds.
import {
  pageOperations as pages,
  publicLinkOperations as links,
  sharingOperations as sharing,
  spaceOperations,
} from '@wikistow/client';
import { schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { signedInPerson } from './support/accounts.ts';
import { personWithVault, rejection } from './support/content.ts';
import { openCopy } from './support/copies.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
let admin: Awaited<ReturnType<typeof signedInPerson>>;
beforeAll(async () => {
  t = await createTestApp();
  admin = await signedInPerson(t, 'admin');
});
afterAll(() => t.drop());

/**
 * A published page in a folder its owner shares with a sharer, an editor
 * who publishes and turned the page's link on, and the owner's copy of it.
 */
async function world() {
  const [owner, sharer] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const spaceId = await spaceOperations.createSpace(owner.ctx, { name: 'Space', kind: 'shared' });
  const folderId = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: null,
    name: 'Folder',
  });
  const shareId = await shareFolder(owner.ctx, {
    spaceId,
    rootId: folderId,
    people: [await invite(owner, sharer, 'editor', true)],
  });
  const pageId = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: folderId,
    title: 'Notes',
    markdown: 'Some notes.',
  });
  const page = { spaceId, pageId };
  await pages.publishPage(owner.ctx, page);
  await links.turnOn(sharer.ctx, pageId);
  await links.shareCopy(owner.ctx, page);
  return { owner, sharer, shareId, page };
}

type World = Awaited<ReturnType<typeof world>>;

const suspend = async (person: Person) => {
  const path = `/api/admin/accounts/${person.id}/suspend`;
  return (await admin.browser.request(path, { method: 'POST' })).status;
};

/** How many in the test database wait for a lock. */
const lockWaits = async () => {
  const [row] = [
    ...(await t.db.execute<{ count: string }>(sql`
      select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`)),
  ];
  return Number(row?.count ?? 0);
};

/** Until `count` wait for a lock, or `action` settles, whichever is first. */
async function waitingOrSettled(action: Promise<unknown>, count: number) {
  let settled = false;
  void action.finally(() => (settled = true));
  for (let i = 0; !settled && (await lockWaits()) < count; i++) {
    if (i > 500) throw new Error(`never ${count} waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const permissionVersion = async (spaceId: string) => {
  const [space] = await t.db
    .select({ permissionVersion: schema.spaces.permissionVersion })
    .from(schema.spaces)
    .where(eq(schema.spaces.id, spaceId));
  return space?.permissionVersion ?? 1;
};

describe('ending a public link while its copy’s uploader is suspended', () => {
  // Each gets ready, then answers the step that ends the page's link, with
  // the owner's copy, as the owner.
  const endings: [string, (w: World) => Promise<() => Promise<unknown>>][] = [
    [
      'unpublishing it',
      async ({ owner, page }) => {
        const { heads, permissionVersion } = await pages.loadPage(owner.ctx, page.pageId);
        const publishedHead = heads.publishedHead;
        if (!publishedHead) throw new Error('expected a publication');
        return () => pages.unpublishPage(owner.ctx, page, { publishedHead, permissionVersion });
      },
    ],
    [
      'turning its link off',
      async ({ owner, page }) =>
        () =>
          links.turnOff(owner.ctx, page.pageId),
    ],
    [
      'removing its sharer from the share',
      async ({ owner, sharer, shareId, page }) =>
        () =>
          sharing.removeMember(owner.ctx, {
            spaceId: page.spaceId,
            shareId,
            identityId: sharer.vault.identity.public.id,
          }),
    ],
    [
      'moving it to the trash',
      async ({ owner, page }) =>
        () =>
          pages.deleteNode(owner.ctx, { spaceId: page.spaceId, nodeId: page.pageId }),
    ],
    [
      'deleting its space',
      async ({ owner, page }) => {
        const version = await permissionVersion(page.spaceId);
        return () =>
          spaceOperations.deleteSpace(owner.ctx, {
            spaceId: page.spaceId,
            permissionVersion: version,
          });
      },
    ],
    [
      'moving it into another space where its mover can’t publish',
      async ({ owner, sharer, page }) => {
        const theirs = await spaceOperations.createSpace(sharer.ctx, { name: 'Theirs' });
        const folder = await spaceOperations.createFolder(sharer.ctx, {
          spaceId: theirs,
          parentId: null,
          name: 'Drafts',
        });
        await shareFolder(sharer.ctx, {
          spaceId: theirs,
          rootId: folder,
          people: [await invite(sharer, owner, 'editor')],
        });
        const copy = await openCopy(owner.ctx, {
          kind: 'move',
          from: page.spaceId,
          nodeId: page.pageId,
          to: theirs,
          parentId: folder,
          published: false,
        });
        await copy.open();
        await copy.send();
        return () => copy.finish();
      },
    ],
  ];

  it.each(endings)('waits for the suspension after %s (#679)', async (_, ready) => {
    const w = await world();
    const end = await ready(w);
    let ended: Promise<string | undefined> | undefined;
    let suspended: Promise<number> | undefined;
    // This transaction holds the copy, so the ending stops there, holding
    // the link. The suspension then comes: it holds the owner's account and
    // waits for the copy. Were the ending to take the owner's account only
    // for its audit record, after the link, each would wait on the other.
    await t.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from public_copies where page_id = ${w.page.pageId} for update`,
      );
      ended = rejection(end());
      await waitingOrSettled(ended, 1);
      suspended = suspend(w.owner);
      await waitingOrSettled(suspended, 2);
    });
    expect({ ended: await ended, suspended: await suspended }).toEqual({
      ended: 'no error',
      suspended: 200,
    });
    const left = await t.db
      .select()
      .from(schema.publicLinks)
      .where(eq(schema.publicLinks.pageId, w.page.pageId));
    expect(left).toEqual([]);
  });
});
