// The one exception to the plaintext rule (ADR 0005): a page with a public
// link has its published version stored readable, and nothing else of it,
// and every way the link or its copy ends leaves nothing readable at once.
import {
  moveOperations as moves,
  pageOperations as pages,
  publicLinkOperations as links,
  sharingOperations as sharing,
  spaceOperations,
  utf8,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { exposes, readableCorpus } from '@wikistow/client/testing';
import { PAGE_CSP, schema, sweepPublicLinks } from '@wikistow/server';
import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { signedInPerson } from './support/accounts.ts';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, shareFolder, type Person } from './support/sharing.ts';
import { snapshot } from './support/snapshot.ts';

let t: TestApp;
let admin: Awaited<ReturnType<typeof signedInPerson>>;
beforeAll(async () => {
  t = await createTestApp();
  admin = await signedInPerson(t, 'admin');
});
afterAll(() => t.drop());

/** Markers of one world, so another world's copies never match them. */
function markers() {
  const n = randomBytes(4).toString('hex');
  return {
    // Readable while the link is on.
    title: `Router notes PLAINTEXT-PUBLIC-TITLE-${n}`,
    body: `Router admin is on vlan 20. PLAINTEXT-PUBLIC-BODY-${n}`,
    usedName: `router PLAINTEXT-USED-NAME-${n}.png`,
    usedBytes: `PNG bytes PLAINTEXT-USED-BYTES-${n}`,
    // Never readable.
    frontmatter: `PLAINTEXT-FRONTMATTER-${n}`,
    draft: `The wifi password is hunter2. PLAINTEXT-DRAFT-${n}`,
    olderTitle: `PLAINTEXT-OLDER-TITLE-${n}`,
    olderBody: `PLAINTEXT-OLDER-BODY-${n}`,
    unusedName: `PLAINTEXT-UNUSED-NAME-${n}.png`,
    unusedBytes: `PLAINTEXT-UNUSED-BYTES-${n}`,
    otherPage: `PLAINTEXT-OTHER-PAGE-${n}`,
  };
}

const TARGET_TITLE = 'Target page';

/**
 * A page in a folder the owner shares with a sharer and an uploader, both
 * editors who publish, with an older publication that had a public copy,
 * then a published version with frontmatter, an attachment its body shows
 * and one it doesn't, and a wikilink to another public page, which links
 * back to it by address; and a draft after it, and a private page beside
 * it. Both pages' links are on, each with a copy the owner uploaded; the
 * sharer turned the first page's on.
 */
async function world() {
  const m = markers();
  const owner = await personWithVault(t);
  const sharer = await personWithVault(t);
  const uploader = await personWithVault(t);
  const spaceId = await spaceOperations.createSpace(owner.ctx, { name: 'Space', kind: 'shared' });
  const folderId = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: null,
    name: 'Folder',
  });
  const shareId = await shareFolder(owner.ctx, {
    spaceId,
    rootId: folderId,
    people: [
      await invite(owner, sharer, 'editor', true),
      await invite(owner, uploader, 'editor', true),
    ],
  });
  const pageId = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: folderId,
    title: m.olderTitle,
    markdown: m.olderBody,
  });
  const page = { spaceId, pageId };
  await pages.publishPage(owner.ctx, page);
  const id = await links.turnOn(sharer.ctx, pageId);
  await links.shareCopy(owner.ctx, page);
  const used = await pages.uploadAttachment(owner.ctx, page, {
    name: m.usedName,
    mediaType: 'image/png',
    bytes: utf8(m.usedBytes),
  });
  const unused = await pages.uploadAttachment(owner.ctx, page, {
    name: m.unusedName,
    mediaType: 'image/png',
    bytes: utf8(m.unusedBytes),
  });
  await pages.editDraft(owner.ctx, page, {
    title: m.title,
    markdown: `---\nsecret: ${m.frontmatter}\n---\n${m.body}\n\n![](attachment:${used.id})\n\nSee [[${TARGET_TITLE}]].\n`,
    attachments: [used, unused],
  });
  await pages.publishPage(owner.ctx, page);
  await pages.editDraft(owner.ctx, page, { markdown: m.draft });
  const other = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: null,
    title: 'Other',
    markdown: m.otherPage,
  });
  await pages.publishPage(owner.ctx, { spaceId, pageId: other });

  const targetId = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: null,
    title: TARGET_TITLE,
    markdown: `Back to [the notes](/s/${spaceId}/p/${pageId}).`,
  });
  const target = { spaceId, pageId: targetId };
  await pages.publishPage(owner.ctx, target);
  const targetLink = await links.turnOn(owner.ctx, targetId);
  await links.shareCopy(owner.ctx, page);
  await links.shareCopy(owner.ctx, target);
  return { m, owner, sharer, uploader, shareId, page, folderId, target, id, targetLink, used };
}

type World = Awaited<ReturnType<typeof world>>;

const visit = (path: string) => t.app.request(path);

const identityOf = (person: Person) => person.vault.identity.public.id;

const suspend = async (person: Person) => {
  const path = `/api/admin/accounts/${person.id}/suspend`;
  expect((await admin.browser.request(path, { method: 'POST' })).status).toBe(200);
};

/** Whether a snapshot of everything the server keeps or says holds `text`. */
async function readable(...texts: string[]) {
  const corpus = readableCorpus(await snapshot(t));
  return texts.map((text) => exposes(corpus, utf8(text)));
}

/** Target rows naming the page, from any copy. */
const rowsNaming = (pageId: PageId) =>
  t.db.select().from(schema.publicTargets).where(eq(schema.publicTargets.targetPageId, pageId));

/** The copy's title, body and the attachment it shows, as `world` made them. */
const copied = (m: World['m']) => [m.title, m.body, m.usedName, m.usedBytes];

describe('a page with a public link', () => {
  it('has only its published title, body and the attachment it shows readable', async () => {
    const w = await world();
    const { m } = w;
    expect(await readable(...copied(m))).toEqual([true, true, true, true]);
    const never = [
      m.frontmatter,
      m.draft,
      m.olderTitle,
      m.olderBody,
      m.unusedName,
      m.unusedBytes,
      m.otherPage,
    ];
    expect(await readable(...never)).toEqual(never.map(() => false));
    // The link ids are in their rows, and nowhere else the server writes.
    const said = JSON.stringify([t.logs, await t.db.select().from(schema.auditEvents)]);
    expect(said).not.toContain(w.id);
    expect(said).not.toContain(w.targetLink);

    // The public page: its own policy, with the hash of its one stylesheet.
    const res = await visit(`/p/${w.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const policy = res.headers.get('content-security-policy');
    expect(policy).toBe(PAGE_CSP);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    const hash = createHash('sha256').update(style).digest('base64');
    expect(policy).toContain(`'sha256-${hash}'`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).not.toContain('<script');
    expect(html).toContain(m.title);
    expect(html).toContain(m.body);
    expect(html).not.toContain(m.frontmatter);
    expect(html).toContain(`<a href="/p/${w.targetLink}">${TARGET_TITLE}</a>`);
    expect(html).toContain(`src="/p/${w.id}/files/${w.used.id}"`);
    const file = await visit(`/p/${w.id}/files/${w.used.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe(m.usedBytes);
    const back = await (await visit(`/p/${w.targetLink}`)).text();
    expect(back).toContain(`<a href="/p/${w.id}">the notes</a>`);

    // Turning the target's link off takes the row naming it with it.
    expect(await rowsNaming(w.target.pageId)).toHaveLength(1);
    await links.turnOff(w.owner.ctx, w.target.pageId);
    expect(await rowsNaming(w.target.pageId)).toEqual([]);
    const now = await (await visit(`/p/${w.id}`)).text();
    expect(now).toContain(`See ${TARGET_TITLE}.`);
    expect((await visit(`/p/${w.targetLink}`)).status).toBe(404);
  });

  const version = async (spaceId: SpaceId) => {
    const [space] = await t.db
      .select({ permissionVersion: schema.spaces.permissionVersion })
      .from(schema.spaces)
      .where(eq(schema.spaces.id, spaceId));
    return space?.permissionVersion ?? 1;
  };

  const endings: [string, (w: World) => Promise<unknown>][] = [
    ['turning the link off', (w) => links.turnOff(w.owner.ctx, w.page.pageId)],
    [
      'unpublishing the page',
      async (w) => {
        const { heads, permissionVersion } = await pages.loadPage(w.owner.ctx, w.page.pageId);
        if (!heads.publishedHead) throw new Error('expected a publication');
        await pages.unpublishPage(w.owner.ctx, w.page, {
          publishedHead: heads.publishedHead,
          permissionVersion,
        });
      },
    ],
    [
      'deleting the page',
      (w) => pages.deleteNode(w.owner.ctx, { spaceId: w.page.spaceId, nodeId: w.page.pageId }),
    ],
    [
      'deleting a folder above it',
      (w) => pages.deleteNode(w.owner.ctx, { spaceId: w.page.spaceId, nodeId: w.folderId }),
    ],
    [
      'deleting its space',
      async (w) =>
        spaceOperations.deleteSpace(w.owner.ctx, {
          spaceId: w.page.spaceId,
          permissionVersion: await version(w.page.spaceId),
        }),
    ],
    // Its sharer losing publish rights, while the live copy is the owner's.
    [
      'moving it where its sharer can’t publish',
      async (w) => {
        const { spaceId, pageId } = w.page;
        const preview = await moves.previewMove(w.owner.ctx, {
          spaceId,
          nodeId: pageId,
          parentId: null,
        });
        await moves.moveNode(w.owner.ctx, { preview });
      },
    ],
    [
      'removing its sharer from the share',
      (w) =>
        sharing.removeMember(w.owner.ctx, {
          spaceId: w.page.spaceId,
          shareId: w.shareId,
          identityId: identityOf(w.sharer),
        }),
    ],
    ['suspending its sharer', (w) => suspend(w.sharer)],
  ];

  for (const [ending, end] of endings) {
    it(`leaves nothing of its copy after ${ending}, and its link is dead`, async () => {
      const w = await world();
      expect(await rowsNaming(w.page.pageId)).toHaveLength(1);
      await end(w);
      // At once, with no sweep.
      expect(await readable(...copied(w.m))).toEqual([false, false, false, false]);
      expect(await rowsNaming(w.page.pageId)).toEqual([]);
      const dead = await visit(`/p/${w.id}`);
      expect(dead.status).toBe(404);
      const unknown = await visit(`/p/${randomBytes(16).toString('base64url')}`);
      expect(await dead.text()).toBe(await unknown.text());
      expect((await visit(`/p/${w.id}/files/${w.used.id}`)).status).toBe(404);
    });
  }

  it('loses only the live copy when its uploader is removed, and keeps its link', async () => {
    const w = await world();
    await links.shareCopy(w.uploader.ctx, w.page);
    // A page of the uploader's own, which they can still publish.
    const own = await spaceOperations.createSpace(w.uploader.ctx, { name: 'Own', kind: 'shared' });
    const kept = `PLAINTEXT-STILL-PUBLIC-${randomBytes(4).toString('hex')}`;
    const ownPage = {
      spaceId: own,
      pageId: await pages.createPage(w.uploader.ctx, {
        spaceId: own,
        parentId: null,
        title: 'Own',
        markdown: kept,
      }),
    };
    await pages.publishPage(w.uploader.ctx, ownPage);
    const ownLink = await links.turnOn(w.uploader.ctx, ownPage.pageId);
    await links.shareCopy(w.uploader.ctx, ownPage);

    await sharing.removeMember(w.owner.ctx, {
      spaceId: w.page.spaceId,
      shareId: w.shareId,
      identityId: identityOf(w.uploader),
    });
    expect(await readable(...copied(w.m), kept)).toEqual([false, false, false, false, true]);
    // The sharer's link stays on, and the target's copy still leads to it.
    expect(await rowsNaming(w.page.pageId)).toHaveLength(1);
    const res = await visit(`/p/${w.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('This page is being updated');
    expect((await visit(`/p/${w.id}/files/${w.used.id}`)).status).toBe(404);
    expect(await (await visit(`/p/${ownLink}`)).text()).toContain(kept);
  });

  it('is ended by the sweep when its sharer lost publish rights some other way', async () => {
    const w = await world();
    // Taken away without a change that ends what lapsed.
    await t.db
      .update(schema.shareMembers)
      .set({ canPublish: false })
      .where(
        and(
          eq(schema.shareMembers.shareId, w.shareId),
          eq(schema.shareMembers.identityId, identityOf(w.sharer)),
        ),
      );
    // And the target's copy staged long ago and left.
    await t.db
      .update(schema.publicCopies)
      .set({ live: false, touchedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.publicCopies.pageId, w.target.pageId));
    await sweepPublicLinks(t.db);
    expect(await readable(...copied(w.m))).toEqual([false, false, false, false]);
    expect((await visit(`/p/${w.id}`)).status).toBe(404);
    const copies = t.db
      .select()
      .from(schema.publicCopies)
      .where(eq(schema.publicCopies.pageId, w.target.pageId));
    expect(await copies).toEqual([]);
    // The owner's link on the target stays.
    expect((await visit(`/p/${w.targetLink}`)).status).toBe(200);
  });

  it('leaves nothing of its copy once a new version is published, and keeps its link', async () => {
    const w = await world();
    await pages.editDraft(w.owner.ctx, w.page, { markdown: 'A new version' });
    await pages.publishPage(w.owner.ctx, w.page);
    expect(await readable(...copied(w.m))).toEqual([false, false, false, false]);
    const res = await visit(`/p/${w.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('This page is being updated');
    expect((await visit(`/p/${w.id}/files/${w.used.id}`)).status).toBe(404);
    // The link stays, and the target's copy still leads to it.
    expect(await rowsNaming(w.page.pageId)).toHaveLength(1);
  });
});

describe('a public page showing other pages’ values (ADR 0006, decision 9)', () => {
  it('holds only those pages’ published values, never a draft its publisher can see', async () => {
    const n = randomBytes(4).toString('hex');
    const m = {
      published: `PLAINTEXT-PUBLISHED-VALUE-${n}`,
      draft: `PLAINTEXT-DRAFT-VALUE-${n}`,
      unreferenced: `PLAINTEXT-UNREFERENCED-VALUE-${n}`,
      unpublished: `PLAINTEXT-UNPUBLISHED-VALUE-${n}`,
    };
    const owner = await personWithVault(t);
    const spaceId = await spaceOperations.createSpace(owner.ctx, {
      name: 'Kitchen',
      kind: 'shared',
    });
    const create = async (title: string, markdown: string) => ({
      spaceId,
      pageId: await pages.createPage(owner.ctx, { spaceId, parentId: null, title, markdown }),
    });
    const bread = await create(
      'Garlic bread',
      `---\ncook_time: "${m.published}"\nother: "${m.unreferenced}"\n---\nBake it.\n`,
    );
    await pages.publishPage(owner.ctx, bread);
    // A draft after it, renamed too: its title chooses nothing, its value never goes.
    await pages.editDraft(owner.ctx, bread, {
      title: 'Garlic toast',
      markdown: `---\ncook_time: "${m.draft}"\n---\nBake it.\n`,
    });
    // A page never published, whose draft its publisher can see.
    await create('Secret soup', `---\nx: "${m.unpublished}"\n---\n`);
    const notes = await create(
      'Notes',
      'Bake `=[[Garlic bread]].cook_time` min. Soup `=[[Secret soup]].x`, `=[[Garlic bread]].nope`.\n',
    );
    await pages.publishPage(owner.ctx, notes);
    const id = await links.turnOn(owner.ctx, notes.pageId);
    await links.shareCopy(owner.ctx, notes);

    expect(await readable(m.published, m.draft, m.unreferenced, m.unpublished)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    const html = await (await visit(`/p/${id}`)).text();
    expect(html).toContain(`Bake ${m.published} min.`);
    // What doesn't resolve to a published value stays as written.
    expect(html).toContain('<code>=[[Secret soup]].x</code>');
    expect(html).toContain('<code>=[[Garlic bread]].nope</code>');
  });
});
