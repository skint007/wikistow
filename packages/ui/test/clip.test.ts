import {
  ApiError,
  FolderId,
  newId,
  PageId,
  RevisionId,
  SpaceId,
  splitFrontmatter,
  type AttachmentRef,
  type DraftSave,
  type PageWriter,
} from '@wikistow/client';
import type { ClipImage, DesktopClip } from '@wikistow/contracts';
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
import { saveClip, type SaveClipDeps } from '../src/clip/save-clip';

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
}: { refuse?: 'page' | 'attach' | 'attach-failed' | 'save' | 'delete' } = {}) {
  const calls: { call: string; input: unknown }[] = [];
  const revisionId = newId(RevisionId);
  let n = 0;
  const writer = {
    async newPageDraft(input: unknown) {
      calls.push({ call: 'newPageDraft', input });
      if (refuse === 'page') throw new ApiError(403, 'forbidden', 'No');
      return { pageId: newId(PageId), revisionId };
    },
    async attach(_page: unknown, file: { name: string; mediaType: string; bytes: Uint8Array }) {
      calls.push({ call: 'attach', input: file.name });
      if (refuse === 'attach') throw new ApiError(413, 'payload-too-large', 'Too large');
      if (refuse === 'attach-failed') throw new Error('Gone');
      n += 1;
      return { id: `att${n}`, name: file.name, mediaType: file.mediaType } as AttachmentRef;
    },
    async deleteNode(input: unknown) {
      calls.push({ call: 'deleteNode', input });
      if (refuse === 'delete') throw new ApiError(404, 'not-found', 'Gone');
      return 'trashed';
    },
    draft() {
      return {
        waitingHead: async () => null,
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

  it('says the page is made as soon as it is, before its images', async () => {
    const { writer, calls } = fakeWriter();
    const told: string[] = [];
    await saveClip(
      clip({ html: '<img src="https://cdn.test/a.png">' }),
      deps({
        writer,
        made: async (page) => {
          told.push(`${page.path} after ${calls.map((c) => c.call).join(',')}`);
        },
      }),
    );
    expect(told).toEqual(['Home / News after newPageDraft']);
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
          told.push(
            `${page.partial ? 'partly' : 'whole'} after ${calls.map((c) => c.call).join(',')}`,
          );
        },
      }),
    );
    expect(told).toEqual(['partly after newPageDraft', 'whole after newPageDraft,attach,save']);
  });

  it('puts a page made partly before a reload in the trash, and saves the screenshot again', async () => {
    const { writer, calls } = fakeWriter();
    const pageId = newId(PageId);
    const saved = await saveClip(
      shot({ made: { spaceId, pageId, path: 'Home / News', partial: true } }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    expect(calls.map((c) => c.call)).toEqual(['deleteNode', 'newPageDraft', 'attach', 'save']);
    expect(calls[0]?.input).toMatchObject({ spaceId, nodeId: pageId, dropChanges: true });
  });

  it('saves the screenshot again even if the partial page is gone already', async () => {
    const { writer, calls } = fakeWriter({ refuse: 'delete' });
    const saved = await saveClip(
      shot({ made: { spaceId, pageId: newId(PageId), path: 'Home / News', partial: true } }),
      deps({ writer }),
    );
    expect(saved.outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    expect(calls.map((c) => c.call)).toEqual(['deleteNode', 'newPageDraft', 'attach', 'save']);
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
