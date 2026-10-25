// The link table against the real server, read with each person's own
// keys: a version names only pages everyone who can open it can open, a
// copy in another space names nothing of its source's, a rename takes no
// title from a draft, and a save goes on when the tree can't be loaded.
import {
  ApiError,
  linkTableOf,
  LINKS_NAMESPACE,
  pageOperations as pages,
  publicationOperations as pubs,
  reviseCover,
  spaceOperations,
  utf8,
  type ClientContext,
  type FolderId,
  type PagePayload,
  type RevisionId,
} from '@wikistow/client';
import { structureRoutes, type RouteDef } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, lyingServer, shareFolder, type Answer } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

type PageRef = pages.PageRef;

/**
 * Olive's space: `Team` is a share Ed edits and publishes in and Rita
 * reads, `Elsewhere` a share only Ivy reads, and `Private`, at the top, the
 * owner region.
 */
async function world() {
  const [olive, ed, rita, ivy] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const spaceId = await spaceOperations.createSpace(olive.ctx, { name: 'Garden' });
  const folder = (parentId: FolderId | null, name: string) =>
    spaceOperations.createFolder(olive.ctx, { spaceId, parentId, name });
  const team = await folder(null, 'Team');
  const elsewhere = await folder(null, 'Elsewhere');
  const privy = await folder(null, 'Private');
  const page = async (parentId: FolderId, title: string, publish = true) => {
    const ref = {
      spaceId,
      pageId: await pages.createPage(olive.ctx, { spaceId, parentId, title }),
    };
    if (publish) await pages.publishPage(olive.ctx, ref);
    return ref;
  };
  const plan = await page(team, 'Plan');
  const draftOnly = await page(team, 'Draft only', false);
  const deep = await page(elsewhere, 'Deep');
  const locked = await page(privy, 'Locked');
  await shareFolder(olive.ctx, {
    spaceId,
    rootId: elsewhere,
    people: [await invite(olive, ivy, 'reader')],
  });
  await shareFolder(olive.ctx, {
    spaceId,
    rootId: team,
    people: [await invite(olive, ed, 'editor', true), await invite(olive, rita, 'reader')],
  });
  return {
    ...{ olive, ed, rita, ivy, spaceId, team, privy, elsewhere },
    ...{ plan, draftOnly, deep, locked, page },
  };
}

/** The payload of `revisionId`, opened with `ctx`'s own keys. */
async function opened(
  ctx: ClientContext,
  page: PageRef,
  audience: 'draft' | 'published',
  revisionId: RevisionId,
): Promise<PagePayload> {
  const { opened } = await pages.openRevisionOf(ctx, page, audience, revisionId);
  if (opened.kind !== 'current') throw new Error('expected a current payload');
  return opened.payload;
}
const table = (payload: PagePayload) => Object.fromEntries(linkTableOf(payload));

describe('the link table', () => {
  it('names to each reader only pages in their own share, opened with their keys', async () => {
    const w = await world();
    const linker = await w.page(w.team, 'Linker', false);
    // Olive sees every page; the draft is in Team.
    const saved = await pages.editDraft(w.olive.ctx, linker, {
      markdown: '[[Plan]] [[Draft only]] [[Deep]] [[Locked]]',
    });
    const published = await pages.publishPage(w.olive.ctx, linker);

    const draft = await opened(w.ed.ctx, linker, 'draft', saved.revisionId);
    expect(table(draft)).toEqual({ plan: w.plan.pageId, 'draft only': w.draftOnly.pageId });
    const read = await opened(w.rita.ctx, linker, 'published', published.revisionId);
    expect(table(read)).toEqual({ plan: w.plan.pageId });
    // Neither names a page outside Team anywhere.
    for (const payload of [draft, read]) {
      for (const outside of [w.deep, w.locked]) {
        expect(JSON.stringify(payload)).not.toContain(outside.pageId);
      }
    }

    // In the owner region, which only owners open, every page of the space is named.
    const owned = await w.page(w.privy, 'Owned', false);
    const ownedDraft = await pages.editDraft(w.olive.ctx, owned, {
      markdown: '[[Deep]] [[Draft only]]',
    });
    expect(table(await opened(w.olive.ctx, owned, 'draft', ownedDraft.revisionId))).toEqual({
      deep: w.deep.pageId,
      'draft only': w.draftOnly.pageId,
    });
  });

  it('is left out of a copy in another space', async () => {
    const w = await world();
    const linker = await w.page(w.team, 'Linker', false);
    // Its banner image is left behind too, so the copy's cover changes as the table goes.
    const banner = await pages.uploadAttachment(w.olive.ctx, linker, {
      name: 'Banner.webp',
      mediaType: 'image/webp',
      bytes: utf8('not really an image'),
    });
    const saved = await pages.editDraft(w.olive.ctx, linker, {
      markdown: 'See [[Plan]].',
      attachments: [banner],
      extensions: reviseCover(
        {},
        { emoji: '🍞', banner: { kind: 'image', attachmentId: banner.id, focal: 30 } },
      ),
    });
    expect(table(saved.payload)).toEqual({ plan: w.plan.pageId });
    const board = await spaceOperations.createSpace(w.olive.ctx, { name: 'Board' });
    const preview = await pubs.previewPublication(w.olive.ctx, {
      source: linker,
      revisionId: saved.revisionId,
      audience: 'draft',
      spaceId: board,
      parentId: null,
    });
    const { pageId, revisionId } = await pubs.publishToSpace(w.olive.ctx, {
      preview,
      attachmentIds: new Set(),
    });
    const copy = { spaceId: board, pageId };
    const published = await opened(w.olive.ctx, copy, 'published', revisionId);
    expect(published.markdown).toBe('See [[Plan]].');
    expect(published.extensions).not.toHaveProperty(LINKS_NAMESPACE);
    expect(JSON.stringify(published)).not.toContain(w.plan.pageId);
    expect(published.extensions['wikistow.cover']).toEqual({
      format: 1,
      emoji: '🍞',
      banner: { kind: 'theme' },
    });
  });
});

describe('a rename written into a link', () => {
  it('takes only a published title, so readers never see one from a draft', async () => {
    const w = await world();
    const linker = await w.page(w.team, 'Linker', false);
    await pages.editDraft(w.ed.ctx, linker, { markdown: 'See [[Plan]] and [[Draft only]].' });
    // Olive renames both in their drafts, and publishes neither.
    await pages.editDraft(w.olive.ctx, w.plan, { title: 'Layoffs 2027' });
    await pages.editDraft(w.olive.ctx, w.draftOnly, { title: 'Secret merger' });

    const saved = await pages.editDraft(w.ed.ctx, linker, {});
    expect(saved.payload.markdown).toBe('See [[Plan]] and [[Draft only]].');
    expect(table(saved.payload)).toEqual({ plan: w.plan.pageId, 'draft only': w.draftOnly.pageId });
    const published = await pages.publishPage(w.ed.ctx, linker);
    const read = await opened(w.rita.ctx, linker, 'published', published.revisionId);
    expect(read.markdown).toBe('See [[Plan]] and [[Draft only]].');
    for (const title of ['Layoffs', 'Secret']) expect(JSON.stringify(read)).not.toContain(title);

    // Published under it, the title may be written in.
    await pages.publishPage(w.olive.ctx, w.plan);
    const after = await pages.editDraft(w.ed.ctx, linker, {});
    expect(after.payload.markdown).toBe('See [[Layoffs 2027]] and [[Draft only]].');
  });
});

describe('a rename written into a reference or a property', () => {
  it('follows the page, changing only the link’s characters, and only once it is published', async () => {
    const w = await world();
    const linker = await w.page(w.team, 'Linker', false);
    const markdown = (title: string) =>
      `---\n# pairing\ngoes_with:  "[[${title}]]"  # side\n---\nReady in \`=[[${title}]].cook_time\` min.\n`;
    await pages.editDraft(w.ed.ctx, linker, { markdown: markdown('Plan') });
    await pages.editDraft(w.olive.ctx, w.plan, { title: 'Roadmap' });
    const kept = await pages.editDraft(w.ed.ctx, linker, {});
    expect(kept.payload.markdown).toBe(markdown('Plan'));
    expect(table(kept.payload)).toEqual({ plan: w.plan.pageId });

    await pages.publishPage(w.olive.ctx, w.plan);
    const after = await pages.editDraft(w.ed.ctx, linker, {});
    expect(after.payload.markdown).toBe(markdown('Roadmap'));
    expect(table(after.payload)).toEqual({ roadmap: w.plan.pageId, plan: w.plan.pageId });
  });
});

describe('a draft saved when the tree can’t be loaded', () => {
  it('is still saved, its table carried as it was and no link renamed', async () => {
    const w = await world();
    const linker = await w.page(w.team, 'Linker', false);
    await pages.editDraft(w.olive.ctx, linker, { markdown: 'See [[Plan]].' });
    await pages.editDraft(w.olive.ctx, w.plan, { title: 'Roadmap' });
    await pages.publishPage(w.olive.ctx, w.plan);
    const failing = lyingServer(
      w.ed.ctx,
      new Map<RouteDef, Answer>([
        [
          structureRoutes.tree,
          async () => {
            throw new ApiError(502, 'unreadable-response', 'The tree is not available');
          },
        ],
      ]),
    );
    const saved = await pages.editDraft(failing.ctx, linker, { markdown: 'See [[Plan]]. More.' });
    expect(failing.sent).toContain(structureRoutes.tree);
    expect(saved).toMatchObject({ linksKept: true, renamed: [] });
    const draft = await opened(w.ed.ctx, linker, 'draft', saved.revisionId);
    expect(draft.markdown).toBe('See [[Plan]]. More.');
    expect(table(draft)).toEqual({ plan: w.plan.pageId });
  });
});
