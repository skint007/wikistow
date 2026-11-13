// A folder's own order of its pages and folders (#400): shared by everyone
// who sees the folder, changed by those who can edit there, and kept tidy by
// moves, copies, the trash and the stream that tells other apps.
import {
  childrenInOrder,
  moveOperations,
  orderOperations,
  pageOperations as pages,
  positionBetween,
  searchOperations,
  shownTitle,
  spaceOperations,
  trashOperations,
  watchTreeChanges,
  type ClientContext,
  type FolderId,
  type SpaceId,
} from '@wikistow/client';
import { Position, structureRoutes } from '@wikistow/contracts';
import { listenForTreeChanges } from '@wikistow/server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { copyAll } from './support/copies.ts';
import { Browser, createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
let listening: Awaited<ReturnType<typeof listenForTreeChanges>>;
beforeAll(async () => {
  t = await createTestApp();
  listening = await listenForTreeChanges(t.config.databaseUrl, t.treeChanges.changed);
});
afterAll(async () => {
  t.treeChanges.close();
  await listening.close();
  await t.drop();
});

const labels = {
  folder: (folder: { metadata: Parameters<typeof searchOperations.nameOf>[0] }) =>
    searchOperations.nameOf(folder.metadata) ?? '',
  page: (page: { title: string | null }) => shownTitle(page.title),
};

/** What `ctx`'s app lists in `parentId`, by label, in order. */
async function listed(ctx: ClientContext, spaceId: SpaceId, parentId: FolderId | null) {
  const tree = await spaceOperations.loadTree(ctx, spaceId);
  return childrenInOrder(tree, parentId, labels).map((child) => child.label);
}

/** The children of `parentId` as an app shows them, for `placing` and `stepping`. */
async function shown(ctx: ClientContext, spaceId: SpaceId, parentId: FolderId | null) {
  const tree = await spaceOperations.loadTree(ctx, spaceId);
  return childrenInOrder(tree, parentId, labels).map(({ node, label }) => ({
    id: node.id,
    position: node.position,
    label,
  }));
}

/** Put `nodeId` just before the child labelled `before` (null: last), as a drop does. */
async function drop(
  ctx: ClientContext,
  spaceId: SpaceId,
  parentId: FolderId | null,
  nodeId: string,
  before: string | null,
) {
  const children = await shown(ctx, spaceId, parentId);
  const beforeId = before === null ? null : (children.find((c) => c.label === before)?.id ?? null);
  const { own, others } = orderOperations.placing(children, nodeId, beforeId);
  await orderOperations.arrange(ctx, { spaceId, parentId, positions: [...others, own] });
}

/** A space with a folder of three pages, in a folder nobody ordered. */
async function shelf(owner: Person) {
  const spaceId = await spaceOperations.createSpace(owner.ctx, { name: 'Shelf' });
  const folder = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: null,
    name: 'Book',
  });
  const page = (title: string) => pages.createPage(owner.ctx, { spaceId, parentId: folder, title });
  const ids = { a: await page('Apples'), b: await page('Bread'), c: await page('Cheese') };
  return { spaceId, folder, ids };
}

describe('a folder’s own order', () => {
  it('lists positions only to an app that asks, so released apps read the tree as before', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    await drop(owner.ctx, spaceId, folder, ids.c, 'Apples');

    const plain = await owner.ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    expect(plain).not.toHaveProperty('positions');
    // Exactly the keys a released app's strict schema reads.
    expect(Object.keys(plain).toSorted()).toEqual(
      ['agentActivity', 'folders', 'pages', 'shares', 'space'].toSorted(),
    );
    const ordered = await owner.ctx.api.call(structureRoutes.tree, {
      params: { spaceId },
      query: { order: '1' },
    });
    expect(ordered.positions?.map((p) => p.id).toSorted()).toEqual(
      [ids.a, ids.b, ids.c].toSorted(),
    );
  });

  it('starts by name, folders first, and mixes folders and pages once ordered', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    const inner = await spaceOperations.createFolder(owner.ctx, {
      spaceId,
      parentId: folder,
      name: 'Zest',
    });
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Zest', 'Apples', 'Bread', 'Cheese']);

    await drop(owner.ctx, spaceId, folder, inner, 'Cheese');
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Apples', 'Bread', 'Zest', 'Cheese']);
    await drop(owner.ctx, spaceId, folder, ids.a, null);
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Bread', 'Zest', 'Cheese', 'Apples']);
  });

  it('is shared: readers see it and can’t change it, editors can, outsiders can’t tell', async () => {
    const owner = await personWithVault(t);
    const [reader, editor, outsider] = await Promise.all([
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
    const second = await pages.createPage(owner.ctx, {
      spaceId: lib.spaceId,
      parentId: lib.shared,
      title: 'Agenda',
    });
    await pages.publishPage(owner.ctx, { spaceId: lib.spaceId, pageId: second });
    expect(await listed(reader.ctx, lib.spaceId, lib.shared)).toEqual(['Agenda', 'Plan']);

    const change = (ctx: ClientContext) =>
      orderOperations.arrange(ctx, {
        spaceId: lib.spaceId,
        parentId: lib.shared,
        positions: [{ nodeId: lib.page.pageId, position: positionBetween(null, null) }],
      });
    expect(await rejection(change(reader.ctx))).toBe('forbidden');
    expect(await rejection(change(outsider.ctx))).toBe('not-found');
    expect(
      await rejection(
        orderOperations.sortByName(reader.ctx, { spaceId: lib.spaceId, parentId: lib.shared }),
      ),
    ).toBe('forbidden');
    expect(await rejection(change(editor.ctx))).toBe('no error');
    // Everyone who sees the folder sees the same order.
    expect(await listed(reader.ctx, lib.spaceId, lib.shared)).toEqual(['Plan', 'Agenda']);
    expect(await listed(owner.ctx, lib.spaceId, lib.shared)).toEqual(['Plan', 'Agenda']);

    // The folder the share starts at sits in a folder its members don't see:
    // they can't order that one, nor learn its place there.
    const above = await rejection(
      orderOperations.arrange(editor.ctx, {
        spaceId: lib.spaceId,
        parentId: lib.above,
        positions: [{ nodeId: lib.shared, position: positionBetween(null, null) }],
      }),
    );
    expect(above).toBe('not-found');
    await drop(owner.ctx, lib.spaceId, lib.above, lib.shared, null);
    const memberTree = await editor.ctx.api.call(structureRoutes.tree, {
      params: { spaceId: lib.spaceId },
      query: { order: '1' },
    });
    expect(memberTree.positions?.map((p) => p.id)).not.toContain(lib.shared);
  });

  it('refuses a node that is in another folder now', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    const result = await rejection(
      orderOperations.arrange(owner.ctx, {
        spaceId,
        parentId: null,
        positions: [{ nodeId: ids.a, position: positionBetween(null, null) }],
      }),
    );
    expect(result).toBe('stale-head');
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Apples', 'Bread', 'Cheese']);
  });

  it('puts something new at the end of an ordered folder, and by name in one that isn’t', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    await pages.createPage(owner.ctx, { spaceId, parentId: folder, title: 'Almonds' });
    expect(await listed(owner.ctx, spaceId, folder)).toEqual([
      'Almonds',
      'Apples',
      'Bread',
      'Cheese',
    ]);

    await drop(owner.ctx, spaceId, folder, ids.c, 'Almonds');
    await pages.createPage(owner.ctx, { spaceId, parentId: folder, title: 'Aaa' });
    await spaceOperations.createFolder(owner.ctx, {
      spaceId,
      parentId: folder,
      name: 'Aaa folder',
    });
    expect(await listed(owner.ctx, spaceId, folder)).toEqual([
      'Cheese',
      'Almonds',
      'Apples',
      'Bread',
      'Aaa',
      'Aaa folder',
    ]);
  });

  it('moves an item in at the end, or where the app puts it, and its old folder lets it go', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    const other = await spaceOperations.createFolder(owner.ctx, {
      spaceId,
      parentId: null,
      name: 'Other',
    });
    const there = (title: string) =>
      pages.createPage(owner.ctx, { spaceId, parentId: other, title });
    const [x, y] = [await there('Xylophone'), await there('Yarn')];
    await drop(owner.ctx, spaceId, other, y, 'Xylophone');
    expect(await listed(owner.ctx, spaceId, other)).toEqual(['Yarn', 'Xylophone']);

    // Moved in with nowhere given: at the end.
    await moveOperations.moveNode(owner.ctx, {
      preview: await moveOperations.previewMove(owner.ctx, {
        spaceId,
        nodeId: ids.a,
        parentId: other,
      }),
    });
    expect(await listed(owner.ctx, spaceId, other)).toEqual(['Yarn', 'Xylophone', 'Apples']);

    // Moved in where it was dropped.
    const { own } = orderOperations.placing(await shown(owner.ctx, spaceId, other), ids.b, x);
    await moveOperations.moveNode(owner.ctx, {
      preview: await moveOperations.previewMove(owner.ctx, {
        spaceId,
        nodeId: ids.b,
        parentId: other,
        position: own.position,
      }),
    });
    expect(await listed(owner.ctx, spaceId, other)).toEqual([
      'Yarn',
      'Bread',
      'Xylophone',
      'Apples',
    ]);
    // Moved back to a folder that lists by name, it lists by name there.
    await moveOperations.moveNode(owner.ctx, {
      preview: await moveOperations.previewMove(owner.ctx, {
        spaceId,
        nodeId: ids.b,
        parentId: folder,
      }),
    });
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Bread', 'Cheese']);
    const tree = await spaceOperations.loadTree(owner.ctx, spaceId);
    expect(tree.pages.find((p) => p.id === ids.b)?.position).toBeNull();
  });

  it('sorts by name again, and a restore goes back where it was while the order lasts', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    await drop(owner.ctx, spaceId, folder, ids.c, 'Apples');
    await drop(owner.ctx, spaceId, folder, ids.a, null);
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Cheese', 'Bread', 'Apples']);

    await pages.deleteNode(owner.ctx, { spaceId, nodeId: ids.b });
    await pages.createPage(owner.ctx, { spaceId, parentId: folder, title: 'Dates' });
    await trashOperations.restoreDeleted(owner.ctx, ids.b);
    expect(await listed(owner.ctx, spaceId, folder)).toEqual([
      'Cheese',
      'Bread',
      'Apples',
      'Dates',
    ]);

    await pages.deleteNode(owner.ctx, { spaceId, nodeId: ids.c });
    await orderOperations.sortByName(owner.ctx, { spaceId, parentId: folder });
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Apples', 'Bread', 'Dates']);
    // Back in a folder that lists by name, it doesn't make it ordered again.
    await trashOperations.restoreDeleted(owner.ctx, ids.c);
    expect(await listed(owner.ctx, spaceId, folder)).toEqual([
      'Apples',
      'Bread',
      'Cheese',
      'Dates',
    ]);
    const tree = await spaceOperations.loadTree(owner.ctx, spaceId);
    expect(tree.pages.every((p) => p.position === null)).toBe(true);
  });

  it('gives nothing new the place of something in the trash, which a restore takes back', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    await drop(owner.ctx, spaceId, folder, ids.c, 'Apples');
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Cheese', 'Apples', 'Bread']);
    await pages.deleteNode(owner.ctx, { spaceId, nodeId: ids.b });
    await pages.createPage(owner.ctx, { spaceId, parentId: folder, title: 'Dates' });
    await trashOperations.restoreDeleted(owner.ctx, ids.b);
    const tree = await spaceOperations.loadTree(owner.ctx, spaceId);
    const positions = tree.pages.flatMap((p) => (p.parentId === folder ? [p.position] : []));
    expect(new Set(positions).size).toBe(positions.length);
    expect(await listed(owner.ctx, spaceId, folder)).toEqual([
      'Cheese',
      'Apples',
      'Bread',
      'Dates',
    ]);
  });

  it('puts a restore just after what took its position meanwhile', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    await drop(owner.ctx, spaceId, folder, ids.c, 'Apples');
    // Cheese, Apples, Bread; Bread to the trash, then Cheese where it was.
    await pages.deleteNode(owner.ctx, { spaceId, nodeId: ids.b });
    await drop(owner.ctx, spaceId, folder, ids.c, null);
    await trashOperations.restoreDeleted(owner.ctx, ids.b);
    const tree = await spaceOperations.loadTree(owner.ctx, spaceId);
    const positions = tree.pages.flatMap((p) => (p.parentId === folder ? [p.position] : []));
    expect(new Set(positions).size).toBe(positions.length);
    expect(await listed(owner.ctx, spaceId, folder)).toEqual(['Apples', 'Cheese', 'Bread']);
  });

  it('says a node moved only to someone who can see it', async () => {
    const owner = await personWithVault(t);
    const editor = await personWithVault(t);
    const lib = await library(owner);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(owner, editor, 'editor')],
    });
    // `beside` is in the folder above the share, which the editor doesn't see.
    const result = await rejection(
      orderOperations.arrange(editor.ctx, {
        spaceId: lib.spaceId,
        parentId: lib.shared,
        positions: [{ nodeId: lib.beside.pageId, position: positionBetween(null, null) }],
      }),
    );
    expect(result).toBe('not-found');
  });

  it('makes room at the end of a folder whose keys grew too long', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    // The longest key there is, which nothing fits after.
    await orderOperations.arrange(owner.ctx, {
      spaceId,
      parentId: folder,
      positions: [
        { nodeId: ids.a, position: Position.parse('a0') },
        { nodeId: ids.b, position: Position.parse('a1') },
        { nodeId: ids.c, position: Position.parse('z'.repeat(100)) },
      ],
    });
    await pages.createPage(owner.ctx, { spaceId, parentId: folder, title: 'Dates' });
    expect(await listed(owner.ctx, spaceId, folder)).toEqual([
      'Apples',
      'Bread',
      'Cheese',
      'Dates',
    ]);
    const tree = await spaceOperations.loadTree(owner.ctx, spaceId);
    expect(tree.pages.every((p) => (p.position?.length ?? 0) < 10)).toBe(true);
  });

  it('orders the top of a space too', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder } = await shelf(owner);
    const top = await pages.createPage(owner.ctx, { spaceId, parentId: null, title: 'Alpha' });
    expect(await listed(owner.ctx, spaceId, null)).toEqual(['Book', 'Alpha']);
    await drop(owner.ctx, spaceId, null, top, 'Book');
    expect(await listed(owner.ctx, spaceId, null)).toEqual(['Alpha', 'Book']);
    expect(folder).toBeTruthy();
  });

  it('copies keep the order inside, and land at the end of an ordered folder', async () => {
    const owner = await personWithVault(t);
    const { spaceId, folder, ids } = await shelf(owner);
    await drop(owner.ctx, spaceId, folder, ids.c, 'Apples');
    await pages.publishPage(owner.ctx, { spaceId, pageId: ids.a });
    for (const id of [ids.b, ids.c]) await pages.publishPage(owner.ctx, { spaceId, pageId: id });
    const target = await spaceOperations.createFolder(owner.ctx, {
      spaceId,
      parentId: null,
      name: 'Target',
    });
    const t1 = await pages.createPage(owner.ctx, { spaceId, parentId: target, title: 'Zoo' });
    await drop(owner.ctx, spaceId, target, t1, null);

    const copy = await copyAll(owner.ctx, {
      from: spaceId,
      nodeId: folder,
      to: spaceId,
      parentId: target,
    });
    const made = copy.newIdOf(folder) as FolderId;
    expect(await listed(owner.ctx, spaceId, target)).toEqual(['Zoo', 'Book']);
    expect(await listed(owner.ctx, spaceId, made)).toEqual(['Cheese', 'Apples', 'Bread']);
  });
});

describe('telling other apps', () => {
  it('tells everyone who sees the space when its order changes', async () => {
    const owner = await personWithVault(t);
    const reader = await personWithVault(t);
    const lib = await library(owner);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(owner, reader, 'reader')],
    });
    const stop = new AbortController();
    try {
      const heard: SpaceId[] = [];
      const { promise: open, resolve } = Promise.withResolvers<void>();
      void watchTreeChanges({
        fetch: async (url, init) => {
          const response = await reader.browser.fetch(url, init);
          if (response.ok) resolve();
          return response;
        },
        signal: stop.signal,
        onChange: (spaceIds) => heard.push(...spaceIds),
        onMissed: () => {},
      });
      await open;
      await drop(owner.ctx, lib.spaceId, lib.shared, lib.page.pageId, null);
      await expect.poll(() => heard, { timeout: 5_000 }).toContain(lib.spaceId);
      const before = heard.length;
      await orderOperations.sortByName(owner.ctx, { spaceId: lib.spaceId, parentId: lib.shared });
      await expect.poll(() => heard.length, { timeout: 5_000 }).toBeGreaterThan(before);
    } finally {
      stop.abort();
    }
    expect(Browser).toBeTruthy();
  });
});
