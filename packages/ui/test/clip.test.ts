import {
  ApiError,
  createPageWriter,
  FolderId,
  generateIdentity,
  IdentityId,
  InstallationId,
  keptOperations,
  memoryKeptStore,
  newId,
  newPayload,
  PageId,
  queueOperations,
  RevisionId,
  SpaceId,
  splitFrontmatter,
  type AttachmentRef,
  type DraftSave,
  type KeptStore,
  type PagePayload,
  type PageWriter,
  type QueuedPage,
  type ServerWrites,
} from '@wikistow/client';
import type { ClipImage, ClipMade, DesktopClip } from '@wikistow/contracts';
import { describe, expect, it } from 'vite-plus/test';
import {
  clipFrontmatter,
  clipParts,
  clipTitle,
  imageName,
  planImages,
  textHtml,
} from '../src/clip/clip-page';
import { rememberedPlaces, searchPlaces, type ClipPlace } from '../src/clip/clip-places';
import { hiddenByTrash, saveClip, type SaveClipDeps } from '../src/clip/save-clip';

const spaceId = newId(SpaceId);
const folderId = newId(FolderId);

const clip = (fields: Partial<DesktopClip> = {}): DesktopClip => ({
  id: 'clip1',
  mode: 'article',
  url: 'https://news.example/story?id=1',
  title: 'A story',
  note: '',
  tags: [],
  html: '<p>Hello</p>',
  text: '',
  byline: null,
  folder: { spaceId, folderId },
  screenshot: null,
  waited: false,
  made: null,
  ...fields,
});

describe('a clip’s title', () => {
  it('is the person’s, on one line, or the site’s, or Clip', () => {
    expect(clipTitle({ title: '  Bread\n  | BBC  ', url: 'https://x.test/' })).toBe('Bread | BBC');
    expect(clipTitle({ title: ' ', url: 'https://www.bbc.co.uk/food' })).toBe('www.bbc.co.uk');
    expect(clipTitle({ title: '', url: 'not an address' })).toBe('Clip');
  });
});

describe('a clip’s pieces', () => {
  it('writes text as HTML that shows it, escaped', () => {
    expect(textHtml('One <b>&\nline\n\n\nTwo')).toBe(
      '<p>One &#60;b&#62;&#38;<br>line</p><p>Two</p>',
    );
  });

  it('makes a link the note, the selection as a quote, and the link; a screenshot its note and link apart', () => {
    expect(
      clipParts(clip({ mode: 'screenshot', note: 'Look', text: 'no', html: '<p>no</p>' })),
    ).toEqual([
      { html: '<p>Look</p>', text: '' },
      { html: '<p><a href="https://news.example/story?id=1">A story</a></p>', text: '' },
    ]);
    expect(
      clipParts(clip({ mode: 'link', note: 'Read # later', text: 'Quoted', html: '<p>no</p>' })),
    ).toEqual([
      {
        html: '<p>Read # later</p><blockquote><p>Quoted</p></blockquote><p><a href="https://news.example/story?id=1">A story</a></p>',
        text: '',
      },
    ]);
  });

  it('links only http: and https: addresses, and writes others as text', () => {
    expect(clipParts(clip({ mode: 'link', url: 'file:///home/a.html' }))[0]?.html).toBe(
      '<p>file:///home/a.html</p>',
    );
    expect(clipParts(clip({ mode: 'link', url: 'javascript:alert(1)', title: '<x>' }))).toEqual([
      { html: '<p>javascript:alert(1)</p>', text: '' },
    ]);
  });

  it('keeps the note apart from the clip’s own HTML, which its styles can’t hide', () => {
    expect(
      clipParts(clip({ note: 'Mine', html: '<style>p{display:none}</style><p>x</p>', text: 'x' })),
    ).toEqual([
      { html: '<p>Mine</p>', text: '' },
      { html: '<style>p{display:none}</style><p>x</p>', text: 'x' },
    ]);
  });
});

describe('a clip’s properties', () => {
  it('are its source, the day, its tags and an article’s author, nothing else', () => {
    const frontmatter = clipFrontmatter(
      clip({ tags: [' news ', 'news', '', 'a: b'], byline: ' Ann Smith ' }),
      '2026-11-13',
    );
    expect(frontmatter).toBe(
      '---\nsource: https://news.example/story?id=1\nclipped: 2026-11-13\ntags: [news, "a: b"]\nauthor: Ann Smith\n---\n',
    );
    expect(clipFrontmatter(clip(), '2026-11-13')).toBe(
      '---\nsource: https://news.example/story?id=1\nclipped: 2026-11-13\n---\n',
    );
  });

  it('come before the body, so frontmatter-like text clipped stays the body', () => {
    const markdown = `${clipFrontmatter(clip(), '2026-11-13')}---\ntitle: Evil\n---\n`;
    const { frontmatter, body } = splitFrontmatter(markdown);
    expect(frontmatter).not.toContain('Evil');
    expect(body).toContain('title: Evil');
  });
});

describe('a clip’s images', () => {
  const page = [
    '![one](https://cdn.test/1.png "One") and ![one again](https://cdn.test/1.png)',
    '![data](data:image/png;base64,AAAA)',
    '![blob](blob:https://site.test/x)',
    '[![in a link](https://cdn.test/2.png)](https://site.test/)',
  ].join('\n\n');

  it('fetches each http:, https: or data: address once', () => {
    expect(planImages(page).fetch).toEqual([
      'https://cdn.test/1.png',
      'data:image/png;base64,AAAA',
      'https://cdn.test/2.png',
    ]);
    expect(planImages(page).count).toBe(4);
    expect(planImages(page, undefined, 1).fetch).toEqual(['https://cdn.test/1.png']);
  });

  it('shows those attached from their attachments, and the rest as links or their text', () => {
    const plan = planImages(page);
    expect(plan.written(new Map())).toBe(
      [
        '[one](https://cdn.test/1.png "One") and [one again](https://cdn.test/1.png)',
        'data',
        'blob',
        '[in a link](https://site.test/)',
      ].join('\n\n'),
    );
    expect(
      plan.written(
        new Map([
          ['https://cdn.test/1.png', 'A1'],
          ['data:image/png;base64,AAAA', 'A2'],
          ['https://cdn.test/2.png', 'A3'],
        ]),
      ),
    ).toBe(
      [
        '![one](attachment:A1 "One") and ![one again](attachment:A1)',
        '![data](attachment:A2)',
        'blob',
        '[![in a link](attachment:A3)](https://site.test/)',
      ].join('\n\n'),
    );
  });

  it('are named from their address, as files can be', () => {
    expect(imageName('https://cdn.test/a/My%20photo.jpeg?w=1', 'image/jpeg')).toBe('My photo.jpg');
    expect(imageName('https://cdn.test/a/b:c*d.png', 'image/png')).toBe('b c d.png');
    expect(imageName('https://cdn.test/', 'image/webp')).toBe('image.webp');
    expect(imageName('data:image/png;base64,AAAA', 'image/png')).toBe('image.png');
  });
});

describe('the folder search', () => {
  const place = (...path: string[]): ClipPlace => ({
    spaceId,
    folderId: path.length > 1 ? newId(FolderId) : null,
    path,
  });
  const places = [
    place('Home'),
    place('Home', 'Cooking'),
    place('Home', 'Cooking', 'Recipes'),
    place('Home', 'Récipes old'),
    place('Work', 'Projects', 'Recipe app'),
  ];

  it('finds every word in the path, own names first, and nothing for nothing typed', () => {
    const paths = (query: string) =>
      searchPlaces(places, query, []).matches.map((p) => p.path.join(' / '));
    expect(paths('recip')).toEqual([
      'Home / Cooking / Recipes',
      'Home / Récipes old',
      'Work / Projects / Recipe app',
    ]);
    expect(paths('home cook')).toEqual(['Home / Cooking', 'Home / Cooking / Recipes']);
    expect(paths('  ')).toEqual([]);
  });

  it('answers at most 50, and the five last used that are still places', () => {
    const many = Array.from({ length: 70 }, (_, i) => place('Home', `Box ${i}`));
    expect(searchPlaces(many, 'box', []).matches).toHaveLength(50);
    const gone = { spaceId, folderId: newId(FolderId) };
    const recent = searchPlaces(places, '', [places[2]!, gone, places[0]!]).recent;
    expect(recent.map((p) => p.path.at(-1))).toEqual(['Recipes', 'Home']);
  });

  it('remembers five, the last first, each once', () => {
    let recent: ClipPlace[] = [];
    for (const one of [...places, places[1]!]) recent = rememberedPlaces(recent, one);
    expect(recent.map((p) => p.path.at(-1))).toEqual([
      'Cooking',
      'Recipe app',
      'Récipes old',
      'Recipes',
      'Home',
    ]);
  });
});

/** A page writer that records what it's asked, as the server or queue would answer. */
function fakeWriter({
  refuse,
  made = [],
  gone = [],
  waiting = null,
  savedSince = false,
  whileAttaching,
}: {
  refuse?: 'page' | 'attach' | 'attach-failed' | 'save' | 'delete' | 'delete-forbidden';
  /** Pages made already, which making again is refused as. */
  made?: PageId[];
  /** Pages in the trash, which attaching to is refused as not found. */
  gone?: PageId[];
  /** The page's change waiting on this device, and the head it's on: none for one the server refused. */
  waiting?: { head: RevisionId | null; payload: PagePayload } | null;
  /** Another window saved into the waiting change after its head was read. */
  savedSince?: boolean;
  /** The waiting change once a file is attached, as the queue sent it or was refused it meanwhile. */
  whileAttaching?: { waiting: { head: RevisionId | null; payload: PagePayload } | null };
} = {}) {
  const calls: { call: string; input: unknown }[] = [];
  const revisionId = newId(RevisionId);
  let n = 0;
  const writer = {
    async newPageDraft(input: { ids?: { pageId: PageId; revisionId: RevisionId } }) {
      calls.push({ call: 'newPageDraft', input });
      if (refuse === 'page') throw new ApiError(403, 'forbidden', 'No');
      if (input.ids && made.includes(input.ids.pageId)) {
        throw new ApiError(409, 'duplicate', 'That page ID is taken');
      }
      return { pageId: input.ids?.pageId ?? newId(PageId), revisionId };
    },
    async attach(
      page: { pageId: PageId },
      file: { name: string; mediaType: string; bytes: Uint8Array },
    ) {
      calls.push({ call: 'attach', input: file.name });
      if (whileAttaching) waiting = whileAttaching.waiting;
      if (gone.includes(page.pageId)) throw new ApiError(404, 'not-found', 'Not found');
      if (refuse === 'attach') throw new ApiError(413, 'payload-too-large', 'Too large');
      if (refuse === 'attach-failed') throw new Error('Gone');
      n += 1;
      return { id: `att${n}`, name: file.name, mediaType: file.mediaType } as AttachmentRef;
    },
    async deleteNode(input: unknown) {
      calls.push({ call: 'deleteNode', input });
      if (refuse === 'delete') throw new ApiError(404, 'not-found', 'Gone');
      if (refuse === 'delete-forbidden') throw new ApiError(403, 'forbidden', 'No');
      return 'trashed';
    },
    draft() {
      return {
        waitingHead: async () => waiting?.head ?? null,
        // Version 1, refused by the server without a head, or saved into after the head was read.
        entryNow: async () =>
          waiting && {
            version: savedSince ? 2 : 1,
            payload: waiting.payload,
            failure: waiting.head ? null : { kind: 'gone' },
          },
        seen: () => (waiting?.head ? 1 : null),
        save: async (input: DraftSave) => {
          calls.push({ call: 'save', input });
          if (refuse === 'save') throw new ApiError(409, 'stale-head', 'Stale');
          return {} as never;
        },
      };
    },
  } as unknown as PageWriter;
  return { writer, calls, revisionId };
}

// A space's tree as the queue shows it (`withQueued`): folders by ID, each at the top, and pages in them.
type QueueTree = Parameters<typeof queueOperations.withQueued>[0];
const spaceTree = (folders: FolderId[], pages: [PageId, FolderId][]) =>
  ({
    space: null,
    shares: [],
    folders: folders.map((id) => ({
      id,
      parentId: null,
      permissionVersion: 1,
      position: null,
      metadata: null,
    })),
    pages: pages.map(([id, parentId]) => ({
      id,
      parentId,
      permissionVersion: 1,
      draftHead: null,
      publishedHead: null,
      draftChanges: false,
      position: null,
      title: 'Clip',
      emoji: null,
      icon: null,
      symbol: null,
      region: null,
    })),
    agentActivity: null,
  }) as unknown as QueueTree;
const trashOf = (id: PageId | FolderId, failure: unknown = null) =>
  ({
    kind: 'delete',
    id,
    node: 'folder',
    spaceId,
    name: 'Gone',
    failure,
    at: 1,
  }) as unknown as queueOperations.QueueEntry;

describe('a page in the trash on this device', () => {
  const pageId = newId(PageId);
  const chosen = newId(FolderId);
  const tree = spaceTree([folderId, chosen], [[pageId, chosen]]);

  it('is hidden by a trash waiting for it, or for its folder', () => {
    expect(hiddenByTrash(tree, spaceId, [trashOf(pageId)], pageId)).toBe(true);
    expect(hiddenByTrash(tree, spaceId, [trashOf(chosen)], pageId)).toBe(true);
  });

  it('isn’t by one for another folder, as the one a clip was first sent to', () => {
    expect(hiddenByTrash(tree, spaceId, [trashOf(folderId)], pageId)).toBe(false);
  });

  it('isn’t by one the server refused, nor when nothing waits, nor if it isn’t there at all', () => {
    expect(hiddenByTrash(tree, spaceId, [trashOf(chosen, { kind: 'forbidden' })], pageId)).toBe(
      false,
    );
    expect(hiddenByTrash(tree, spaceId, [], pageId)).toBe(false);
    expect(hiddenByTrash(tree, spaceId, [trashOf(chosen)], newId(PageId))).toBe(false);
  });

  it('is by one waiting beside another the server refused', () => {
    const refused = trashOf(pageId, { kind: 'forbidden' });
    expect(hiddenByTrash(tree, spaceId, [refused, trashOf(chosen)], pageId)).toBe(true);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const here: ClipPlace = { spaceId, folderId, path: ['Home', 'News'] };

function deps(overrides: Partial<SaveClipDeps> = {}): SaveClipDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    writer: fakeWriter().writer,
    places: async () => ({ places: [here], unread: new Set() }),
    // As `htmlMarkdown` would write the test's HTML: its text, with any image.
    convert: async (html, text) => ({
      markdown: `${html.replace(/<img src="([^"]*)">/g, '![]($1)').replace(/<[^>]+>/g, '') || text}\n`,
      faithful: !html.includes('odd'),
    }),
    image: async (url): Promise<ClipImage> => {
      asked.push(url);
      return url.includes('broken')
        ? { ok: false, reason: 'failed' }
        : { ok: true, bytes: PNG, mediaType: 'image/png' };
    },
    today: '2026-11-13',
    choose: async () => null,
    ...overrides,
  };
}

describe('saving a clip', () => {
  it('makes the page with its text, attaches its images, then points them at the attachments', async () => {
    const { writer, calls, revisionId } = fakeWriter();
    const run = deps({ writer });
    const saved = await saveClip(
      clip({
        html: '<p>Hi<img src="https://cdn.test/a.png"><img src="https://cdn.test/broken.png"></p>',
      }),
      run,
    );
    expect(saved.outcome).toEqual({
      ok: true,
      spaceId,
      pageId: expect.any(String),
      title: 'A story',
      path: 'Home / News',
      images: { saved: 1, skipped: 1 },
      faithful: true,
    });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'save']);
    expect(calls[0]?.input).toEqual({
      spaceId,
      parentId: folderId,
      title: 'A story',
      markdown:
        '---\nsource: https://news.example/story?id=1\nclipped: 2026-11-13\n---\nHi[](https://cdn.test/a.png)[](https://cdn.test/broken.png)\n',
      ids: {
        pageId: (saved.outcome as { pageId: PageId }).pageId,
        revisionId: expect.any(String),
        sent: false,
      },
    });
    expect(calls[1]?.input).toBe('a.png');
    const save = calls[2]?.input as DraftSave;
    expect(save.basedOn).toBe(revisionId);
    expect(save.payload.markdown).toBe(
      '---\nsource: https://news.example/story?id=1\nclipped: 2026-11-13\n---\nHi![](attachment:att1)[](https://cdn.test/broken.png)\n',
    );
    expect(save.payload.attachments).toEqual([expect.objectContaining({ id: 'att1' })]);
    expect(run.asked).toEqual(['https://cdn.test/a.png', 'https://cdn.test/broken.png']);
  });

  it('saves no second version without images, and says when it reads otherwise', async () => {
    const { writer, calls } = fakeWriter();
    const saved = await saveClip(clip({ html: '<p>odd</p>' }), deps({ writer }));
    expect(saved.outcome).toMatchObject({
      ok: true,
      images: { saved: 0, skipped: 0 },
      faithful: false,
    });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft']);
  });

  it('keeps an image too large to upload as a link', async () => {
    const { writer, calls } = fakeWriter({ refuse: 'attach' });
    const saved = await saveClip(
      clip({ html: '<img src="https://cdn.test/a.png">' }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 0, skipped: 1 } });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach']);
  });

  it('keeps the text if the save pointing at the images fails', async () => {
    const { writer } = fakeWriter({ refuse: 'save' });
    const saved = await saveClip(
      clip({ html: '<img src="https://cdn.test/a.png">' }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 0, skipped: 1 } });
  });

  it('refuses a page too long for one version before making anything', async () => {
    const { writer, calls } = fakeWriter();
    const saved = await saveClip(clip({ html: 'x'.repeat(300 * 1024) }), deps({ writer }));
    expect(saved.outcome).toMatchObject({ ok: false, code: 'too-large' });
    expect(calls).toEqual([]);
  });

  it('refuses a folder that isn’t a place, when the popup is there to choose again', async () => {
    const { writer, calls } = fakeWriter();
    const saved = await saveClip(
      clip({ folder: { spaceId, folderId: newId(FolderId) } }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: false, code: 'no-folder' });
    expect(calls).toEqual([]);
  });

  it('asks where to put a clip that waited, once its folder can’t take it', async () => {
    const { writer, calls } = fakeWriter();
    const asked: string[] = [];
    const other: ClipPlace = { spaceId, folderId: null, path: ['Home'] };
    const choose = async (_clip: DesktopClip, title: string) => {
      asked.push(title);
      return other;
    };
    const gone = clip({ waited: true, folder: { spaceId, folderId: newId(FolderId) } });
    const saved = await saveClip(gone, deps({ writer, choose }));
    expect(asked).toEqual(['A story']);
    expect(saved).toMatchObject({ outcome: { ok: true, path: 'Home' }, place: other });
    expect(calls[0]?.input).toMatchObject({ parentId: null });
    const dropped = await saveClip(gone, deps({ writer, choose: async () => null }));
    expect(dropped.outcome).toMatchObject({ ok: false, code: 'no-folder' });
  });

  it('says a refusal from the server in its words', async () => {
    const { writer } = fakeWriter({ refuse: 'page' });
    expect((await saveClip(clip(), deps({ writer }))).outcome).toMatchObject({
      ok: false,
      code: 'not-allowed',
    });
  });

  it('finishes a clip whose page was made before a reload, making no other', async () => {
    const { writer, calls } = fakeWriter();
    const pageId = newId(PageId);
    const saved = await saveClip(
      clip({ made: { spaceId, pageId, path: 'Home / News' } }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, pageId, path: 'Home / News' });
    expect(calls).toEqual([]);
  });

  it('says the page’s ID before it’s made, and that it is as soon as it is, before its images', async () => {
    const { writer, calls } = fakeWriter();
    const told: ClipMade[] = [];
    const when: string[] = [];
    const saved = await saveClip(
      clip({ html: '<img src="https://cdn.test/a.png">' }),
      deps({
        writer,
        made: async (page) => {
          told.push(page);
          when.push(calls.map((c) => c.call).join(','));
        },
      }),
    );
    const { ids } = calls[0]!.input as { ids: { pageId: PageId; revisionId: RevisionId } };
    const { pageId, revisionId } = ids;
    expect(ids).toEqual({ pageId, revisionId, sent: false });
    expect(told).toEqual([
      { spaceId, pageId, revisionId, path: 'Home / News', making: true },
      { spaceId, pageId, path: 'Home / News' },
    ]);
    expect(when).toEqual(['', 'newPageDraft']);
    expect(saved.outcome).toMatchObject({ ok: true, pageId });
  });

  it('makes a page a reload cut short before it was made under the IDs kept', async () => {
    const { writer, calls } = fakeWriter();
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    const told: ClipMade[] = [];
    const saved = await saveClip(
      clip({
        html: '<p>Hi<img src="https://cdn.test/a.png"></p>',
        made: { spaceId, pageId, revisionId, path: 'Home / News', making: true },
      }),
      deps({ writer, made: async (page) => void told.push(page) }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, pageId, images: { saved: 1, skipped: 0 } });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'save']);
    // As sent: the server, or this device, may have it under them.
    expect(calls[0]?.input).toMatchObject({ ids: { pageId, revisionId, sent: true } });
    expect(told).toEqual([{ spaceId, pageId, path: 'Home / News' }]);
  });

  it('finishes a clip whose page a reload cut short just after it was made, making no other', async () => {
    const pageId = newId(PageId);
    const { writer, calls } = fakeWriter({ made: [pageId] });
    const saved = await saveClip(
      clip({
        html: '<p>Hi<img src="https://cdn.test/a.png"></p>',
        made: { spaceId, pageId, revisionId: newId(RevisionId), path: 'Home / News', making: true },
      }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, spaceId, pageId, path: 'Home / News' });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft']);
  });

  it('queues a clip to a space not kept offline, whose folders it can’t read', async () => {
    const { writer, calls } = fakeWriter();
    const saved = await saveClip(
      clip(),
      deps({ writer, places: async () => ({ places: [], unread: new Set([spaceId]) }) }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, path: '' });
    expect(calls[0]?.input).toMatchObject({ spaceId, parentId: folderId });
  });

  it('fails a clip whose properties can’t be written, rather than throwing', async () => {
    const { writer, calls } = fakeWriter();
    const saved = await saveClip(clip({ url: '\u0001'.repeat(20_000) }), deps({ writer }));
    expect(saved.outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(calls).toEqual([]);
  });

  it('refuses a clip far too long before reading its links', async () => {
    const { writer } = fakeWriter();
    let read = false;
    const huge = clip({ html: '<img src="https://cdn.test/a.png">x'.repeat(100_000) });
    const saved = await saveClip(
      huge,
      deps({
        writer,
        convert: async (html) => ({ markdown: html, faithful: true }),
        spans: async () => {
          read = true;
          throw new Error('Not read');
        },
      }),
    );
    expect(saved.outcome).toMatchObject({ ok: false, code: 'too-large' });
    expect(read).toBe(false);
  });
});

describe('saving a screenshot', () => {
  const shot = (fields: Partial<DesktopClip> = {}) =>
    clip({
      mode: 'screenshot',
      html: '',
      title: 'A [story]',
      note: 'Look at this',
      screenshot: { bytes: PNG, mediaType: 'image/png' },
      ...fields,
    });

  it('makes the page with its note and link, then shows the screenshot above the link', async () => {
    const { writer, calls, revisionId } = fakeWriter();
    const run = deps({
      writer,
      // As `htmlMarkdown` writes a paragraph and a link.
      convert: async (html) => ({
        markdown: `${html
          .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '[$2]($1)')
          .replace(/<[^>]+>/g, '')}\n`,
        faithful: true,
      }),
    });
    const saved = await saveClip(shot(), run);
    expect(saved.outcome).toEqual({
      ok: true,
      spaceId,
      pageId: expect.any(String),
      title: 'A [story]',
      path: 'Home / News',
      images: { saved: 1, skipped: 0 },
      faithful: true,
    });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'save']);
    const front = '---\nsource: https://news.example/story?id=1\nclipped: 2026-11-13\n---\n';
    expect(calls[0]?.input).toMatchObject({
      markdown: `${front}Look at this\n\n[A [story]](https://news.example/story?id=1)\n`,
    });
    expect(calls[1]?.input).toBe('Screenshot.png');
    const save = calls[2]?.input as DraftSave;
    expect(save.basedOn).toBe(revisionId);
    expect(save.payload.markdown).toBe(
      `${front}Look at this\n\n![Screenshot](attachment:att1)\n\n[A [story]](https://news.example/story?id=1)\n`,
    );
    expect(save.payload.attachments).toEqual([expect.objectContaining({ id: 'att1' })]);
    expect(run.asked).toEqual([]);
  });

  it('names a JPEG as one', async () => {
    const { writer, calls } = fakeWriter();
    await saveClip(
      shot({ screenshot: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' } }),
      deps({ writer }),
    );
    expect(calls[1]?.input).toBe('Screenshot.jpg');
  });

  it('refuses one the server won’t take as too large, putting the page it made in the trash', async () => {
    const { writer, calls } = fakeWriter({ refuse: 'attach' });
    const saved = await saveClip(shot(), deps({ writer }));
    expect(saved.outcome).toMatchObject({ ok: false, code: 'too-large' });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'deleteNode']);
    expect(calls[2]?.input).toMatchObject({ spaceId, node: 'page', dropChanges: true });
  });

  it('fails, putting the page in the trash, if the screenshot can’t be attached', async () => {
    const { writer, calls } = fakeWriter({ refuse: 'attach-failed' });
    const saved = await saveClip(shot(), deps({ writer }));
    expect(saved.outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'deleteNode']);
  });

  it('says its page is made only partly until the screenshot is saved in it', async () => {
    const { writer, calls } = fakeWriter();
    const told: string[] = [];
    await saveClip(
      shot(),
      deps({
        writer,
        made: async (page) => {
          const stage = page.making ? 'making' : page.partial ? 'partly' : 'whole';
          told.push(`${stage} after ${calls.map((c) => c.call).join(',')}`);
        },
      }),
    );
    expect(told).toEqual([
      'making after ',
      'partly after newPageDraft',
      'whole after newPageDraft,attach,save',
    ]);
  });

  it('makes a page a reload cut short before it was made under the ID kept, with the screenshot', async () => {
    const { writer, calls } = fakeWriter();
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    const saved = await saveClip(
      shot({ made: { spaceId, pageId, revisionId, path: 'Home / News', making: true } }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, pageId, images: { saved: 1, skipped: 0 } });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'save']);
    expect(calls[0]?.input).toMatchObject({ ids: { pageId, revisionId, sent: true } });
  });

  it('adds the screenshot to a page a reload cut short just after it was made, making no other', async () => {
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    const { writer, calls } = fakeWriter({ made: [pageId] });
    const told: ClipMade[] = [];
    const saved = await saveClip(
      shot({ made: { spaceId, pageId, revisionId, path: 'Home / News', making: true } }),
      deps({ writer, made: async (page) => void told.push(page) }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, pageId, images: { saved: 1, skipped: 0 } });
    expect(calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'save']);
    const save = calls[2]!.input as DraftSave;
    expect(save.basedOn).toBe(revisionId);
    expect(save.payload.markdown).toContain('![Screenshot](attachment:att1)');
    expect(told).toEqual([{ spaceId, pageId, path: 'Home / News' }]);
  });

  it('saves the screenshot again if the page a reload cut short is in the trash already', async () => {
    const pageId = newId(PageId);
    const { writer, calls } = fakeWriter({ made: [pageId], gone: [pageId] });
    const saved = await saveClip(
      shot({
        made: { spaceId, pageId, revisionId: newId(RevisionId), path: 'Home / News', making: true },
      }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    expect(saved.outcome).not.toMatchObject({ pageId });
    expect(calls.map((c) => c.call)).toEqual([
      'newPageDraft',
      'attach',
      'newPageDraft',
      'attach',
      'save',
    ]);
    // The new page's ID is kept before it's made, as any.
    const { ids: again } = calls[2]!.input as {
      ids: { pageId: PageId; revisionId: RevisionId; sent: boolean };
    };
    expect(again.pageId).not.toBe(pageId);
    expect(again.sent).toBe(false);
  });

  it('says a partly made page’s first draft, so a reload can add the screenshot to it', async () => {
    const { writer, revisionId } = fakeWriter();
    const told: ClipMade[] = [];
    await saveClip(shot(), deps({ writer, made: async (page) => void told.push(page) }));
    expect(told[1]).toMatchObject({ revisionId, partial: true });
  });

  // A page made partly is never put in the trash (#681): a person who can
  // add pages to a shared folder may not trash them, and a save that failed
  // after the trash would leave nothing of the note.
  describe('made partly before a reload', () => {
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    const partly = (fields: Partial<DesktopClip> = {}) =>
      shot({
        made: { spaceId, pageId, revisionId, path: 'Home / News', partial: true },
        ...fields,
      });

    it('adds the screenshot to it, making no other', async () => {
      const { writer, calls } = fakeWriter();
      const told: ClipMade[] = [];
      const saved = await saveClip(
        partly(),
        deps({ writer, made: async (page) => void told.push(page) }),
      );
      expect(saved.outcome).toEqual({
        ok: true,
        spaceId,
        pageId,
        title: 'A [story]',
        path: 'Home / News',
        images: { saved: 1, skipped: 0 },
        faithful: true,
      });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'save']);
      const save = calls[1]?.input as DraftSave;
      expect(save.basedOn).toBe(revisionId);
      expect(save.payload.markdown).toContain('![Screenshot](attachment:att1)');
      expect(save.payload.attachments).toEqual([expect.objectContaining({ id: 'att1' })]);
      expect(told).toEqual([{ spaceId, pageId, path: 'Home / News' }]);
    });

    it('adds it even where the person can’t put pages in the trash', async () => {
      const { writer, calls } = fakeWriter({ refuse: 'delete-forbidden' });
      const saved = await saveClip(partly(), deps({ writer }));
      expect(saved.outcome).toMatchObject({ ok: true, pageId });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'save']);
    });

    it('adds it even if the folders can’t be loaded', async () => {
      const { writer, calls } = fakeWriter();
      const saved = await saveClip(
        partly(),
        deps({ writer, places: () => Promise.reject(new ApiError(500, 'internal', 'No')) }),
      );
      expect(saved.outcome).toMatchObject({ ok: true, pageId });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'save']);
    });

    it('keeps it, with the note and link, if the screenshot can’t be added', async () => {
      for (const refuse of ['attach', 'attach-failed'] as const) {
        const { writer, calls } = fakeWriter({ refuse });
        const saved = await saveClip(partly(), deps({ writer }));
        expect(saved.outcome).toMatchObject({
          ok: false,
          code: refuse === 'attach' ? 'too-large' : 'failed',
          message: expect.stringContaining('Its page keeps your note and link.'),
        });
        expect(calls.map((c) => c.call)).not.toContain('deleteNode');
        expect(calls.map((c) => c.call)).not.toContain('newPageDraft');
      }
    });

    // The page as the clip wrote it, first without the screenshot, then with it as `att1`.
    async function written() {
      const { writer, calls } = fakeWriter();
      await saveClip(shot(), deps({ writer }));
      const first = calls[0]!.input as { title: string; markdown: string };
      const whole = (calls[2]!.input as DraftSave).payload;
      return { first: { ...newPayload(first), attachments: [] }, whole };
    }

    it('adds it on the draft the server has now, keeping all else the person changed', async () => {
      const { first } = await written();
      const head = newId(RevisionId);
      const cover = { 'wikistow.cover': { emoji: '🌲' } };
      const markdown = first.markdown.replace(
        'clipped: 2026-11-13',
        'clipped: 2026-11-13\nmine: yes',
      );
      const { writer, calls } = fakeWriter();
      const saved = await saveClip(
        partly(),
        deps({
          writer,
          current: async () => ({ head, payload: { ...first, markdown, extensions: cover } }),
        }),
      );
      expect(saved.outcome).toMatchObject({ ok: true, pageId });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'save']);
      const save = calls[1]!.input as DraftSave;
      expect(save.basedOn).toBe(head);
      expect(save.payload.extensions).toEqual(cover);
      expect(save.payload.markdown).toContain('mine: yes');
      expect(save.payload.markdown).toContain('![Screenshot](attachment:att1)');
    });

    it('leaves it as the person changed it on the server, adding nothing', async () => {
      const { first } = await written();
      const { writer, calls } = fakeWriter();
      const saved = await saveClip(
        partly(),
        deps({
          writer,
          current: async () => ({
            head: newId(RevisionId),
            payload: { ...first, markdown: `${first.markdown}My words\n` },
          }),
        }),
      );
      expect(saved.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('Its page changed since WikiStow made it'),
      });
      expect(calls).toEqual([]);
    });

    it('finds the screenshot in it already, on the server or here, adding no other', async () => {
      const { whole } = await written();
      const head = newId(RevisionId);
      const online = fakeWriter();
      const onServer = await saveClip(
        partly(),
        deps({ writer: online.writer, current: async () => ({ head, payload: whole }) }),
      );
      expect(onServer.outcome).toMatchObject({ ok: true, pageId });
      expect(online.calls).toEqual([]);
      const offline = fakeWriter({ waiting: { head, payload: whole } });
      const here = await saveClip(partly(), deps({ writer: offline.writer }));
      expect(here.outcome).toMatchObject({ ok: true, pageId });
      expect(offline.calls).toEqual([]);
    });

    it('fails, keeping it, if its change waiting here was refused, screenshot and all', async () => {
      const { whole } = await written();
      const { writer, calls } = fakeWriter({ waiting: { head: null, payload: whole } });
      const saved = await saveClip(partly(), deps({ writer }));
      expect(saved.outcome).toMatchObject({ ok: false, code: 'failed' });
      expect(calls).toEqual([]);
    });

    it('makes it again if the server says it’s gone, and adds nothing offline, unseen', async () => {
      const gone = fakeWriter();
      const remade = await saveClip(
        partly(),
        deps({
          writer: gone.writer,
          current: () => Promise.reject(new ApiError(404, 'not-found', 'Not found')),
        }),
      );
      expect(remade.outcome).toMatchObject({ ok: true });
      expect(remade.outcome).not.toMatchObject({ pageId });
      expect(gone.calls.map((c) => c.call)).toEqual(['newPageDraft', 'attach', 'save']);
      const offline = fakeWriter();
      const added = await saveClip(
        partly(),
        deps({
          writer: offline.writer,
          current: () => Promise.reject(new ApiError(0, 'network', 'No answer')),
        }),
      );
      expect(added.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('couldn’t see its page offline'),
      });
      expect(offline.calls).toEqual([]);
    });

    it('looks at the page again once the screenshot is in, as the queue may send it meanwhile', async () => {
      const { first } = await written();
      // Sent while the screenshot went in, with the person's words in it, under its first draft.
      const edited = { ...first, markdown: `${first.markdown}My words\n` };
      const sent = fakeWriter({
        waiting: { head: revisionId, payload: first },
        whileAttaching: { waiting: null },
      });
      const saved = await saveClip(
        partly(),
        deps({ writer: sent.writer, current: async () => ({ head: revisionId, payload: edited }) }),
      );
      expect(saved.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('Its page changed since WikiStow made it'),
      });
      expect(sent.calls.map((c) => c.call)).toEqual(['attach']);
      // Refused by the server meanwhile: the person sorts that out first.
      const refused = fakeWriter({
        waiting: { head: revisionId, payload: first },
        whileAttaching: { waiting: { head: null, payload: first } },
      });
      const stopped = await saveClip(partly(), deps({ writer: refused.writer }));
      expect(stopped.outcome).toMatchObject({ ok: false, code: 'failed' });
      expect(refused.calls.map((c) => c.call)).toEqual(['attach']);
    });

    it('keeps it if a 404 isn’t the server’s own, making no other', async () => {
      const proxy = new ApiError(404, 'unreadable-response', 'Not JSON');
      const read = fakeWriter();
      const unread = await saveClip(
        partly(),
        deps({ writer: read.writer, current: () => Promise.reject(proxy) }),
      );
      expect(unread.outcome).toMatchObject({ ok: false, code: 'failed' });
      expect(read.calls).toEqual([]);
      const attaching = fakeWriter();
      const writer = { ...attaching.writer, attach: () => Promise.reject(proxy) } as PageWriter;
      const unattached = await saveClip(partly(), deps({ writer }));
      expect(unattached.outcome).toMatchObject({ ok: false, code: 'failed' });
      expect(attaching.calls).toEqual([]);
    });

    it('adds it in the folder the person chose, though the one it was sent to waits for the trash', async () => {
      const chosen = newId(FolderId);
      const tree = spaceTree([folderId, chosen], [[pageId, chosen]]);
      const { writer, calls } = fakeWriter();
      const saved = await saveClip(
        partly({ waited: true }),
        deps({
          writer,
          trashedHere: async (page) =>
            hiddenByTrash(tree, spaceId, [trashOf(folderId)], page.pageId),
        }),
      );
      expect(saved.outcome).toMatchObject({ ok: true, pageId });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'save']);
    });

    it('looks for its folder again if the person put that in the trash here meanwhile', async () => {
      const { writer, calls } = fakeWriter();
      const saved = await saveClip(
        partly(),
        deps({
          writer,
          trashedHere: async () => true,
          // As the tree shows it once the folder is in the trash.
          places: async () => ({ places: [], unread: new Set() }),
        }),
      );
      expect(saved.outcome).toMatchObject({ ok: false, code: 'no-folder' });
      expect(calls).toEqual([]);
    });

    it('leaves its change waiting here alone if another window saved into it meanwhile', async () => {
      const { first } = await written();
      const { writer, calls } = fakeWriter({
        waiting: { head: revisionId, payload: first },
        savedSince: true,
      });
      const saved = await saveClip(partly(), deps({ writer }));
      expect(saved.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('Its page changed since WikiStow made it'),
      });
      expect(calls).toEqual([]);
    });

    it('says its page changed if the server has a newer draft of it', async () => {
      const { writer, calls } = fakeWriter({ refuse: 'save' });
      const saved = await saveClip(partly(), deps({ writer }));
      expect(saved.outcome).toMatchObject({
        ok: false,
        code: 'failed',
        message: expect.stringContaining('Its page changed since WikiStow made it'),
      });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'save']);
    });

    it('keeps it if the screenshot is gone, making nothing', async () => {
      const { writer, calls } = fakeWriter();
      const saved = await saveClip(partly({ screenshot: null }), deps({ writer }));
      expect(saved.outcome).toMatchObject({ ok: false, code: 'failed' });
      expect(calls).toEqual([]);
    });

    it('saves the screenshot again if the page is in the trash already', async () => {
      const { writer, calls } = fakeWriter({ gone: [pageId] });
      const saved = await saveClip(partly(), deps({ writer }));
      expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
      expect(saved.outcome).not.toMatchObject({ pageId });
      expect(calls.map((c) => c.call)).toEqual(['attach', 'newPageDraft', 'attach', 'save']);
    });
  });

  it('finishes a screenshot whose page was made whole before a reload, making no other', async () => {
    const { writer, calls } = fakeWriter();
    const pageId = newId(PageId);
    const saved = await saveClip(
      shot({ made: { spaceId, pageId, path: 'Home / News' } }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, pageId, images: { saved: 1, skipped: 0 } });
    expect(calls).toEqual([]);
  });

  it('refuses a screenshot clip with no screenshot, making nothing', async () => {
    const { writer, calls } = fakeWriter();
    const saved = await saveClip(shot({ screenshot: null }), deps({ writer }));
    expect(saved.outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(calls).toEqual([]);
  });
});

// Offline, a clip waits in this device's queue. A lock closes the queue: a
// write after it keeps nothing, so the clip waits for the next unlock, and
// is saved whole then, rather than said saved without its images (#670).
describe('a lock while an offline clip saves', () => {
  const who = {
    identity: generateIdentity({ id: newId(IdentityId), kind: 'human' }),
    installationId: newId(InstallationId),
  };
  const offline = new ApiError(0, 'network', 'No answer');
  const server: ServerWrites = {
    createPage: () => Promise.reject(offline),
    createFolder: () => Promise.reject(offline),
    saveDraft: () => Promise.reject(offline),
    uploadAttachment: () => Promise.reject(offline),
    uploadBlob: () => Promise.reject(offline),
    updateMetadata: () => Promise.reject(offline),
    deleteNode: () => Promise.reject(offline),
  };
  // A session over `store`, offline; `lockAfterAttach` locks it as soon as a file is attached.
  async function unlock(store: KeptStore, { lockAfterAttach = false } = {}) {
    const kept = await keptOperations.KeptContent.open(store, who);
    const writer = createPageWriter({ queue: kept.queue, server, isOnline: () => false });
    const locking: PageWriter = {
      ...writer,
      attach: async (page, file) => {
        const ref = await writer.attach(page, file);
        if (lockAfterAttach) kept.close();
        return ref;
      },
    };
    return { kept, writer: locking };
  }
  // Main's copy of the clip, as `clipMade` keeps it.
  const mainCopy = () => {
    let made: ClipMade | null = null;
    return { made: async (page: ClipMade) => void (made = page), copy: () => made };
  };
  const pages = async (kept: keptOperations.KeptContent) =>
    (await kept.queue.entries()).filter((entry) => entry.kind === 'page');

  async function saveAcrossLock(
    first: DesktopClip,
    convert?: SaveClipDeps['convert'],
    unlocked: Partial<SaveClipDeps> = {},
  ) {
    const store = memoryKeptStore();
    const main = mainCopy();
    const locked = await unlock(store, { lockAfterAttach: true });
    const before = await saveClip(
      first,
      deps({ writer: locked.writer, made: main.made, ...(convert && { convert }) }),
    );
    // Unlocked again: the clip, as main holds it, is saved again.
    const again = await unlock(store);
    const after = await saveClip(
      { ...first, made: main.copy() },
      deps({ writer: again.writer, made: main.made, ...(convert && { convert }), ...unlocked }),
    );
    return { before, after, kept: again.kept };
  }

  const screenshotClip = () =>
    clip({
      mode: 'screenshot',
      html: '',
      note: 'Look at this',
      screenshot: { bytes: PNG, mediaType: 'image/png' },
    });
  const plainText: SaveClipDeps['convert'] = async (html) => ({
    markdown: `${html.replace(/<[^>]+>/g, '')}\n`,
    faithful: true,
  });

  it('keeps a screenshot clip for the unlock, and saves it with its screenshot then', async () => {
    const { before, after, kept } = await saveAcrossLock(screenshotClip(), plainText);
    expect(before.outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(after.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    // One page, the one said saved, showing its screenshot, whose file waits with it.
    const [page, ...others] = await pages(kept);
    expect(others).toEqual([]);
    expect(page).toMatchObject({ id: (after.outcome as { pageId: PageId }).pageId });
    const { payload } = page as QueuedPage;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.markdown).toContain(`![Screenshot](attachment:${payload.attachments[0]!.id})`);
    expect(await kept.queue.blob(payload.attachments[0]!.blobHash)).not.toBeNull();
    // Nothing waits to go to the trash: the page left behind was never sent.
    expect((await kept.queue.entries()).filter((entry) => entry.kind === 'delete')).toEqual([]);
  });

  it('adds the screenshot at the unlock to the page it left, even if the folders can’t be loaded', async () => {
    const { before, after, kept } = await saveAcrossLock(screenshotClip(), plainText, {
      places: () => Promise.reject(new ApiError(500, 'internal', 'No')),
    });
    expect(before.outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(after.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    const [page, ...others] = await pages(kept);
    expect(others).toEqual([]);
    expect(page).toMatchObject({ id: (after.outcome as { pageId: PageId }).pageId });
    expect((page as QueuedPage).payload.markdown).toContain('![Screenshot](attachment:');
  });

  it('keeps a page made partly that was sent, putting nothing in the trash and making no other', async () => {
    // Sent before going offline: a trash waiting here would be refused once
    // sent, to a person who can add pages but not trash them (#681). Its
    // draft on the server can't be seen offline, so nothing is written on it.
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    const { kept, writer } = await unlock(memoryKeptStore());
    const saved = await saveClip(
      {
        ...screenshotClip(),
        made: { spaceId, pageId, revisionId, path: 'Home / News', partial: true },
      },
      deps({
        writer,
        convert: plainText,
        current: () => Promise.reject(new ApiError(0, 'network', 'No answer')),
      }),
    );
    expect(saved.outcome).toMatchObject({ ok: false, code: 'failed' });
    expect(await kept.queue.entries()).toEqual([]);
  });

  it('leaves the page a lock cut short as the person changed it, rather than write over it', async () => {
    const store = memoryKeptStore();
    const main = mainCopy();
    const first = screenshotClip();
    const locked = await unlock(store, { lockAfterAttach: true });
    await saveClip(first, deps({ writer: locked.writer, made: main.made, convert: plainText }));
    // Unlocked, the person writes in the page before the clip is saved again.
    const again = await unlock(store);
    const { pageId, spaceId: at } = main.copy()!;
    const drafts = again.writer.draft({ spaceId: at, pageId }, { seen: null });
    const basedOn = (await drafts.waitingHead())!;
    await drafts.save({ basedOn, payload: newPayload({ title: 'Mine', markdown: 'My words\n' }) });
    const after = await saveClip(
      { ...first, made: main.copy() },
      deps({ writer: again.writer, made: main.made, convert: plainText }),
    );
    expect(after.outcome).toMatchObject({ ok: false, code: 'failed' });
    const [page, ...others] = await pages(again.kept);
    expect(others).toEqual([]);
    expect((page as QueuedPage).payload).toMatchObject({ title: 'Mine', markdown: 'My words\n' });
  });

  it('keeps what else the person changed in the page a lock cut short, such as its cover', async () => {
    const store = memoryKeptStore();
    const main = mainCopy();
    const first = screenshotClip();
    const locked = await unlock(store, { lockAfterAttach: true });
    await saveClip(first, deps({ writer: locked.writer, made: main.made, convert: plainText }));
    const again = await unlock(store);
    const { pageId, spaceId: at } = main.copy()!;
    const drafts = again.writer.draft({ spaceId: at, pageId }, { seen: null });
    const basedOn = (await drafts.waitingHead())!;
    const waiting = (await drafts.waitingChange())!;
    const extensions = { 'wikistow.cover': { emoji: '🌲' } };
    await drafts.save({ basedOn, payload: { ...waiting.payload, extensions } });
    const after = await saveClip(
      { ...first, made: main.copy() },
      deps({ writer: again.writer, made: main.made, convert: plainText }),
    );
    expect(after.outcome).toMatchObject({ ok: true, pageId });
    const [page] = (await pages(again.kept)) as QueuedPage[];
    expect(page!.payload.extensions).toEqual(extensions);
    expect(page!.payload.markdown).toContain('![Screenshot](attachment:');
  });

  it('finds the screenshot saved already when a reload came just after, adding no other', async () => {
    const store = memoryKeptStore();
    const told: ClipMade[] = [];
    const { kept, writer } = await unlock(store);
    const first = screenshotClip();
    const before = await saveClip(
      first,
      deps({ writer, made: async (page) => void told.push(page), convert: plainText }),
    );
    expect(before.outcome).toMatchObject({ ok: true });
    const [saved] = (await pages(kept)) as QueuedPage[];
    // Main heard it was made partly, but not yet that it is whole.
    const partly = told.find((page) => page.partial)!;
    const after = await saveClip({ ...first, made: partly }, deps({ writer, convert: plainText }));
    expect(after.outcome).toMatchObject({ ok: true, pageId: partly.pageId });
    const [page, ...others] = await pages(kept);
    expect(others).toEqual([]);
    expect((page as QueuedPage).payload.attachments).toEqual(saved!.payload.attachments);
  });

  it('keeps the properties of the page a lock cut short when it adds the screenshot', async () => {
    const { kept, after } = await saveAcrossLock(screenshotClip(), plainText, {
      today: '2026-11-14',
    });
    expect(after.outcome).toMatchObject({ ok: true });
    const [page] = await pages(kept);
    expect((page as QueuedPage).payload.markdown).toContain('clipped: 2026-11-13');
  });

  it('makes the clip again if the person put its page made partly in the trash here meanwhile', async () => {
    // Sent, then put in the trash offline: the trash waits to be sent.
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    const { kept, writer } = await unlock(memoryKeptStore());
    await writer.deleteNode({ spaceId, nodeId: pageId, node: 'page', name: 'Clip' });
    const tree = spaceTree([folderId], [[pageId, folderId]]);
    const trashedHere = async (page: { pageId: PageId }) =>
      hiddenByTrash(tree, spaceId, await kept.queue.entries(), page.pageId);
    const saved = await saveClip(
      {
        ...screenshotClip(),
        made: { spaceId, pageId, revisionId, path: 'Home / News', partial: true },
      },
      deps({ writer, convert: plainText, trashedHere }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    expect(saved.outcome).not.toMatchObject({ pageId });
    const [page, ...others] = await pages(kept);
    expect(others).toEqual([]);
    expect(page).toMatchObject({ id: (saved.outcome as { pageId: PageId }).pageId });
    expect((page as QueuedPage).payload.markdown).toContain('![Screenshot](attachment:');
  });

  it('says a text clip’s images a lock stopped weren’t saved, keeping them as links', async () => {
    const store = memoryKeptStore();
    const { kept, writer } = await unlock(store, { lockAfterAttach: true });
    const saved = await saveClip(
      clip({ html: '<p>Hi<img src="https://cdn.test/a.png"></p>' }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 0, skipped: 1 } });
    const after = await unlock(store);
    const [page, ...others] = await pages(after.kept);
    expect(others).toEqual([]);
    expect(page).toMatchObject({ id: (saved.outcome as { pageId: PageId }).pageId });
    expect((page as QueuedPage).payload.markdown).toContain('Hi[](https://cdn.test/a.png)');
    expect(kept.closed).toBe(true);
  });
});
