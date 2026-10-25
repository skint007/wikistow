import { describe, expect, it } from 'vite-plus/test';
import {
  FolderId,
  LINKS_NAMESPACE,
  linkTableOf,
  newFolderMetadata,
  newPayload,
  OWNER_REGION,
  PageId,
  RevisionId,
  ShareId,
  SpaceId,
  linksInUse,
  placedWikilinks,
  readProperties,
  resolveLinked,
  splitFrontmatter,
  tableWikilinks,
  writeLinks as linked,
  type LinkTree,
  type LinkWrite,
  type OpenedPublication,
  type PagePayload,
  type Region,
} from '../src/index.ts';

const spaceId = SpaceId.parse('space');
const folder = (id: string) => FolderId.parse(id);
const page = (id: string) => PageId.parse(id);
const published = RevisionId.parse('r-published');

// A space whose top is the owner region, with two folder shares: the
// shared folder is share S, and the other share S2.
const S: Region = { kind: 'share', spaceId, shareId: ShareId.parse('share-s') };
const S2: Region = { kind: 'share', spaceId, shareId: ShareId.parse('share-s2') };
const REGION_OF: Record<string, Region> = { 'f-shared': S, 'f-other': S, 'f-elsewhere': S2 };

const tree: LinkTree = {
  shares: [
    { spaceId, shareId: ShareId.parse('share-s'), rootId: 'f-shared' },
    { spaceId, shareId: ShareId.parse('share-s2'), rootId: 'f-elsewhere' },
  ],
  folders: [
    ['f-shared', null, 'Shared'],
    ['f-elsewhere', null, 'Elsewhere'],
    ['f-other', 'f-shared', 'Other'],
    ['f-private', null, 'Private'],
  ].map(([id, parentId, name]) => ({
    id: folder(id ?? ''),
    parentId: parentId ? folder(parentId) : null,
    metadata: { opened: { kind: 'current' as const, metadata: newFolderMetadata(name ?? '') } },
  })),
  pages: (
    [
      ['p-self', 'f-shared', 'Notes', true],
      ['p-plan', 'f-shared', 'Plan', true],
      ['p-draft', 'f-shared', 'Draft only', false],
      ['p-twin-1', 'f-shared', 'Twin', true],
      ['p-twin-2', 'f-other', 'Twin', true],
      ['p-deep', 'f-elsewhere', 'Deep', true],
      ['p-locked', 'f-private', 'Locked', true],
      ['p-top', null, 'Top', true],
    ] as const
  ).map(([id, parentId, title, isPublished]) => ({
    id: page(id),
    parentId: parentId ? folder(parentId) : null,
    title: title as string | null,
    // As the key material of the version its title came from puts it.
    region: (parentId && REGION_OF[parentId]) || OWNER_REGION,
    publishedHead: isPublished ? published : null,
  })),
};

/**
 * Each page's publication as the writer's app opens it: by default a
 * published page of `tree` under its title there, in its region; `changes`
 * gives a page another, or none (undefined).
 */
function publications(changes: Record<string, OpenedPublication | undefined> = {}) {
  const open: LinkWrite['published'] = async (pages) => {
    const opened = new Map<PageId, OpenedPublication>();
    for (const { id } of pages) {
      const listed = tree.pages.find((p) => p.id === id);
      const found =
        id in changes
          ? changes[id]
          : listed?.title && listed.region
            ? { title: listed.title, region: listed.region }
            : undefined;
      if (found) opened.set(id, found);
    }
    return opened;
  };
  return { open };
}

const withTitle = (id: string, title: string): LinkTree => ({
  ...tree,
  pages: tree.pages.map((p) => (p.id === id ? { ...p, title } : p)),
});

/** A page renamed, and published under its new title, as the writer sees it. */
const renamedTo = (id: string, title: string): Partial<LinkWrite> => {
  const region = tree.pages.find((p) => p.id === id)?.region ?? OWNER_REGION;
  return {
    tree: () => withTitle(id, title),
    published: publications({ [id]: { title, region } }).open,
  };
};

const write = (overrides: Partial<LinkWrite> = {}): LinkWrite => ({
  page: { id: page('p-self'), parentId: folder('f-shared') },
  audience: 'draft',
  region: S,
  tableRegion: S,
  tree: () => tree,
  published: publications().open,
  ...overrides,
});

const payload = (markdown: string, links?: Record<string, string>): PagePayload =>
  newPayload({
    title: 'Notes',
    markdown,
    extensions: links
      ? {
          [LINKS_NAMESPACE]: {
            format: 1,
            links: Object.entries(links).map(([key, pageId]) => ({ key, pageId })),
          },
        }
      : {},
  });

/** The payload `writeLinks` writes, which most tests look at alone. */
const writeLinks = async (...args: Parameters<typeof linked>) => (await linked(...args)).payload;

/** The table written, as key → page. */
const table = async (written: Promise<PagePayload>) =>
  Object.fromEntries(linkTableOf(await written));

describe('the audience rule', () => {
  it('keeps a page in the same share in a publication only when it is published', async () => {
    const out = writeLinks(payload('[[Plan]] [[Draft only]]'), write({ audience: 'published' }));
    expect(await table(out)).toEqual({ plan: 'p-plan' });
  });

  it('leaves out a page in another region: another share, the owner region, the top', async () => {
    const markdown = '[[Deep]] [[Locked]] [[Top]]';
    expect(await table(writeLinks(payload(markdown), write()))).toEqual({});
    const out = await writeLinks(payload(markdown), write());
    expect(out.extensions).not.toHaveProperty(LINKS_NAMESPACE);
    // Picked for the link, such a page still names nothing.
    const picked = write({ chosen: new Map([['deep', page('p-deep')]]) });
    expect(await table(writeLinks(payload('[[Deep]]'), picked))).toEqual({});
  });
});

describe('carrying entries forward', () => {
  // An agent sees only its pick: the shared folder's subfolder "Other".
  const picked: LinkTree = {
    shares: [{ spaceId, shareId: ShareId.parse('share-s'), rootId: 'f-other' }],
    folders: [
      {
        id: folder('f-other'),
        parentId: null,
        metadata: { opened: { kind: 'current', metadata: newFolderMetadata('Other') } },
      },
    ],
    pages: [
      {
        id: page('p-agent'),
        parentId: folder('f-other'),
        title: 'Agent notes',
        region: S,
        publishedHead: null,
      },
    ],
  };
  const agentWrite = write({
    page: { id: page('p-agent'), parentId: folder('f-other') },
    tree: () => picked,
  });

  it('keeps an entry whose page the writer can’t see while the link’s text is unchanged', async () => {
    const before = payload('[[Plan]] and [[Draft only]]', {
      plan: 'p-plan',
      'draft only': 'p-draft',
    });
    const out = await writeLinks(
      { ...before, markdown: 'Now [[plan]] only. [[Deep]]' },
      agentWrite,
    );
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ plan: 'p-plan' });
    // Its source isn't touched: the writer doesn't know the page's title.
    expect(out.markdown).toBe('Now [[plan]] only. [[Deep]]');
  });

  it('carries nothing into a publication: the publisher must see the page published', async () => {
    const out = writeLinks(payload('[[Plan]]', { plan: 'p-plan' }), {
      ...agentWrite,
      audience: 'published',
    });
    expect(await table(out)).toEqual({});
  });
});

describe('following a rename', () => {
  const roadmap = renamedTo('p-plan', 'Roadmap');

  it('writes the published title into a link without its own text, and keys it so', async () => {
    const out = await writeLinks(
      payload('See [[Plan]], [[ plan #Dates]] and [[Plan|the plan]].', { plan: 'p-plan' }),
      write(roadmap),
    );
    expect(out.markdown).toBe('See [[Roadmap]], [[ Roadmap #Dates]] and [[Plan|the plan]].');
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ roadmap: 'p-plan', plan: 'p-plan' });
  });

  it('not when its entry is left out: the new title stays with those who can open it', async () => {
    const locked = withTitle('p-locked', 'Vault');
    const out = await writeLinks(
      payload('[[Locked]]', { locked: 'p-locked' }),
      write({ tree: () => locked }),
    );
    expect(out.markdown).toBe('[[Locked]]');
    expect(linkTableOf(out).size).toBe(0);
  });

  it('not to a title a link can’t hold, nor onto text another link names differently', async () => {
    for (const title of ['A|B', 'A#B', 'A]]B']) {
      const out = await writeLinks(
        payload('[[Plan]]', { plan: 'p-plan' }),
        write(renamedTo('p-plan', title)),
      );
      expect(out.markdown, title).toBe('[[Plan]]');
      expect(Object.fromEntries(linkTableOf(out)), title).toEqual({ plan: 'p-plan' });
    }
    // "[[Twin]]" is ambiguous here, so renaming Plan to Twin would change its meaning.
    const out = await writeLinks(
      payload('[[Plan]] [[Twin]]', { plan: 'p-plan' }),
      write(renamedTo('p-plan', 'Twin')),
    );
    expect(out.markdown).toBe('[[Plan]] [[Twin]]');
  });
});

describe('links in properties and references to other pages’ values', () => {
  const roadmap = renamedTo('p-plan', 'Roadmap');

  it('rewrites a reference’s page to the published title, and keys it so', async () => {
    const out = await writeLinks(
      payload('Ready in `=[[Plan]].cook_time` and `` = [[plan]]. cook time `` min.', {
        plan: 'p-plan',
      }),
      write(roadmap),
    );
    expect(out.markdown).toBe(
      'Ready in `=[[Roadmap]].cook_time` and `` = [[Roadmap]]. cook time `` min.',
    );
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ roadmap: 'p-plan', plan: 'p-plan' });
  });

  it('changes only a property value’s characters, byte for byte', async () => {
    const block = (plan: string) =>
      [
        '---',
        '# The pairing',
        `goes_with:   "${plan}"   # a side`,
        `single: '${plan}'`,
        `plain_list: [a, b]`,
        `shown: "[[Plan|the plan]]"`,
        '---',
        '',
      ].join('\r\n');
    const markdown = `${block('[[Plan]]')}Body [[Plan]].\r\n`;
    const out = await writeLinks(payload(markdown, { plan: 'p-plan' }), write(roadmap));
    expect(out.markdown).toBe(`${block('[[Roadmap]]')}Body [[Roadmap]].\r\n`);
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ roadmap: 'p-plan', plan: 'p-plan' });
  });

  it('keys a property’s link it can’t rewrite in place, and leaves the value as written', async () => {
    const markdown = '---\nanchored: &a "[[Plan]]"\nalias: *a\n---\nBody\n';
    const out = await writeLinks(payload(markdown, { plan: 'p-plan' }), write(roadmap));
    expect(out.markdown).toBe(markdown);
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ plan: 'p-plan' });
  });

  it('writes a title a YAML string must quote so that it reads back', async () => {
    const out = await writeLinks(
      payload("---\nsee: '[[Plan]]'\n---\n", { plan: 'p-plan' }),
      write(renamedTo('p-plan', `Bob's "plan": v2`)),
    );
    const read = readProperties(splitFrontmatter(out.markdown).frontmatter);
    expect(read.ok && read.properties[0]?.value).toBe(`[[Bob's "plan": v2]]`);
  });

  it('gives a property’s link and a reference entries, as the body’s links get them', async () => {
    const out = await writeLinks(
      payload('---\nsee: "[[Plan]]"\nlong: "about [[Top]]"\n---\n`=[[Twin]].x` `=[[Deep]].y`'),
      write({ audience: 'draft', region: OWNER_REGION, tableRegion: OWNER_REGION }),
    );
    // Twin is ambiguous; a link inside a longer value is text.
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ plan: 'p-plan', deep: 'p-deep' });
  });

  it('keeps their entries in use', async () => {
    const trimmed = await linksInUse(
      payload('---\nsee: "[[Plan]]"\n---\n`=[[Deep]].y`', {
        plan: 'p-plan',
        deep: 'p-deep',
        gone: 'p-top',
      }),
    );
    expect(Object.fromEntries(linkTableOf(trimmed))).toEqual({ plan: 'p-plan', deep: 'p-deep' });
  });
});

describe('a page picked for an ambiguous link', () => {
  const chosen = (key: string, id: string) => new Map([[key, page(id)]]);

  it('holds on the next save as the earlier entry, without being picked again', async () => {
    const first = await writeLinks(
      payload('[[Twin]]'),
      write({ chosen: chosen('twin', 'p-twin-2') }),
    );
    expect(await table(writeLinks(first, write()))).toEqual({
      twin: 'p-twin-2',
    });
  });
});

describe('payloads without a table', () => {
  it('reads an M2 payload as having none, and writes one on its next save', async () => {
    const m2 = newPayload({ title: 'Notes', markdown: '[[Plan]]' });
    expect(linkTableOf(m2).size).toBe(0);
    expect(await table(writeLinks(m2, write()))).toEqual({ plan: 'p-plan' });
  });

  it('keeps a newer format’s table only in a draft in the region it came from', async () => {
    const newer = newPayload({
      title: 'Notes',
      markdown: '[[Plan]]',
      extensions: { [LINKS_NAMESPACE]: { format: 2, entries: {} }, other: { kept: true } },
    });
    expect(await writeLinks(newer, write())).toEqual(newer);
    // Anywhere else it can't be checked, so it is worked out afresh in format 1.
    const fresh = {
      other: { kept: true },
      [LINKS_NAMESPACE]: { format: 1, links: [{ key: 'plan', pageId: 'p-plan' }] },
    };
    expect((await writeLinks(newer, write({ audience: 'published' }))).extensions).toEqual(fresh);
    expect((await writeLinks(newer, write({ tableRegion: S2 }))).extensions).toEqual(fresh);
  });
});

describe('links read somewhere that can fail (`read`)', () => {
  const timedOut = async (): Promise<never> => {
    throw new Error('Reading the Markdown took too long');
  };
  const before = payload('See [[Plan]].', { plan: 'p-plan', old: 'p-locked' });

  it('keeps a draft’s table as it was, with no tree loaded, when the read fails', async () => {
    const tree = () => {
      throw new Error('no tree needed');
    };
    const out = await linked(before, write({ read: timedOut, tree }));
    expect(out).toEqual({ payload: before, inUse: before, renamed: [], kept: true });
  });
});

describe('a rename takes only a published title, from the same region', () => {
  const before = payload('[[Plan]]', { plan: 'p-plan' });

  it('not a title only in the page’s draft: publishing the link would show it to readers', async () => {
    const out = await writeLinks(
      before,
      write({ tree: () => withTitle('p-plan', 'Layoffs 2027') }),
    );
    expect(out.markdown).toBe('[[Plan]]');
    expect(Object.fromEntries(linkTableOf(out))).toEqual({ plan: 'p-plan' });
    // Never published: no title to take, and the entry stays for editors.
    const never = await writeLinks(
      payload('[[Draft only]]', { 'draft only': 'p-draft' }),
      write({ tree: () => withTitle('p-draft', 'Secret plan') }),
    );
    expect(never.markdown).toBe('[[Draft only]]');
    expect(Object.fromEntries(linkTableOf(never))).toEqual({ 'draft only': 'p-draft' });
  });

  it('keeps the link’s old text in the table for this version, so a stale copy still names the page', async () => {
    const renamed = await writeLinks(before, write(renamedTo('p-plan', 'Roadmap')));
    expect(renamed.markdown).toBe('[[Roadmap]]');
    expect(Object.fromEntries(linkTableOf(renamed))).toEqual({ roadmap: 'p-plan', plan: 'p-plan' });
    // An agent sends its copy from before the rename on top.
    const stale = await writeLinks(
      { ...renamed, markdown: 'More. [[Plan]]' },
      write(renamedTo('p-plan', 'Roadmap')),
    );
    expect(stale.markdown).toBe('More. [[Roadmap]]');
    // Once the text no longer has it, the old key goes.
    const next = await writeLinks(
      { ...renamed, markdown: '[[Roadmap]]' },
      write(renamedTo('p-plan', 'Roadmap')),
    );
    expect(Object.fromEntries(linkTableOf(next))).toEqual({ roadmap: 'p-plan' });
  });
});

describe('a publication into a share goes only by what its readers can read', () => {
  // Plan is renamed New Plan, and published so. Q's draft has just been
  // renamed Plan, but it is still published as Quarterly.
  const newPlan = withTitle('p-plan', 'New Plan');
  const withQ = (draft = 'Plan'): LinkTree => ({
    ...newPlan,
    pages: [
      ...newPlan.pages,
      {
        id: page('p-q'),
        parentId: folder('f-shared'),
        title: draft,
        region: S,
        publishedHead: published,
      },
    ],
  });
  const opened = (q: string) =>
    publications({
      'p-plan': { title: 'New Plan', region: S },
      'p-q': { title: q, region: S },
    }).open;
  const publish = (q = 'Quarterly', overrides: Partial<LinkWrite> = {}) =>
    write({ audience: 'published', tree: () => withQ(), published: opened(q), ...overrides });

  it('and names no page by its draft title, with or without an entry for it', async () => {
    expect(await table(writeLinks(payload('See [[Plan]].'), publish()))).toEqual({});
    // The draft's save named Q by the title its writer saw.
    expect(await table(writeLinks(payload('See [[Plan]].', { plan: 'p-q' }), publish()))).toEqual(
      {},
    );
  });
});

describe('carrying entries across a change of region', () => {
  const unseen = { ...tree, pages: tree.pages.filter((p) => p.id !== 'p-plan') };
  const before = payload('[[Plan]]', { plan: 'p-plan' });

  it('carries an entry only from a table in the write’s region', async () => {
    expect(await table(writeLinks(before, write({ tree: () => unseen })))).toEqual({
      plan: 'p-plan',
    });
    // Moved from S2, or a table from who knows where: dropped and worked out again.
    expect(await table(writeLinks(before, write({ tree: () => unseen, tableRegion: S2 })))).toEqual(
      {},
    );
    const { tableRegion: _, ...untold } = write({ tree: () => unseen });
    expect(await table(writeLinks(before, untold))).toEqual({});
    // An entry whose page the writer sees is checked against the new region too.
    const moved = writeLinks(
      payload('[[Plan]] [[Deep]]', { plan: 'p-plan', deep: 'p-deep' }),
      write({ tableRegion: S2 }),
    );
    expect(await table(moved)).toEqual({ plan: 'p-plan' });
  });
});

describe('resolving through a table', () => {
  const pages = [
    { id: 'p-plan', title: 'Roadmap', folders: [] },
    { id: 'p-other', title: 'Plan', folders: [] },
  ];

  it('follows an entry to a page the viewer has, and gives any other no say', () => {
    const links = placedWikilinks('[[Plan]] [[Secret]] ![[plan.png]]');
    // An embed names an attachment, never through the table.
    const table = new Map([
      ['plan', 'p-plan'],
      ['secret', 'p-hidden'],
      ['plan.png', 'p-plan'],
    ]);
    const resolved = resolveLinked(links, { pages, selfId: 'p-self', table });
    expect(resolved.map(({ status, targets }) => [status, targets])).toEqual([
      ['resolved', ['p-plan']],
      ['missing', []],
      ['missing', []],
    ]);
  });
});

/**
 * A cut-down version of the review's fuzz: documents mixing renamed links
 * with frontmatter, tabs, table cells, code spans, comments, escapes,
 * embeds, folder prefixes and titles that fold oddly. Whatever is renamed,
 * every byte outside a renamed link is unchanged, and a renamed link keeps
 * its heading, shown text and embed mark.
 */
describe('rename byte safety', () => {
  const TITLES: [string, string, string][] = [
    // [page, old title, new title]
    ['p-a', 'Plan', 'Road*map_ / ~~v2~~'],
    ['p-b', 'Café notes', 'İstanbul trip'],
    ['p-c', 'İzmir', 'Café list'],
    ['p-d', 'a_b', 'x * y'],
  ];
  const fuzzTree: LinkTree = {
    shares: [{ spaceId, shareId: ShareId.parse('share-s'), rootId: null }],
    folders: [
      {
        id: folder('f-dir'),
        parentId: null,
        metadata: { opened: { kind: 'current', metadata: newFolderMetadata('Dir') } },
      },
    ],
    pages: TITLES.map(([id, , title]) => ({
      id: page(id),
      parentId: folder('f-dir'),
      title,
      region: S,
      publishedHead: published,
    })),
  };
  const opened = publications(
    Object.fromEntries(TITLES.map(([id, , title]) => [id, { title, region: S }])),
  );
  const PIECES = [
    ...TITLES.flatMap(([, old]) => [
      `[[${old}]]`,
      `[[ ${old} ]]`,
      `[[${old}#Sec]]`,
      `[[Dir/${old}]]`,
      `[[${old}|shown]]`,
      `![[${old}]]`,
      `[[${old.toUpperCase()}]]`,
      `\`[[${old}]]\``,
      `\\[[${old}]]`,
      `<!-- [[${old}]] -->`,
      `| [[${old}\\|cell]] | b |`,
      `\`=[[${old}]].cook_time\``,
      `\`\` = [[${old}]].x \`\``,
    ]),
    '\n',
    '\r\n',
    '\t',
    ' ',
    'text',
    '| a | b |\n|---|---|\n',
    '`',
    '<b>',
    '\\',
    '*',
  ];

  function* documents(count: number) {
    let seed = 1234;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let n = 0; n < count; n++) {
      const front =
        next() < 0.3
          ? next() < 0.5
            ? '---\nsee: "[[Plan]]"\n---\n'
            : '---\r\nx: 1\r\n---\r\n'
          : '';
      const parts = Array.from(
        { length: 1 + Math.floor(next() * 14) },
        () => PIECES[Math.floor(next() * PIECES.length)],
      );
      yield front + parts.join('');
    }
  }

  it('changes nothing but the renamed links’ targets', async () => {
    const entries = Object.fromEntries(
      TITLES.flatMap(([id, old]) => [
        [old.toLocaleLowerCase('en'), id],
        [`dir/${old}`.toLocaleLowerCase('en'), id],
      ]),
    );
    let renames = 0;
    let [inProperties, inReferences] = [0, 0];
    for (const markdown of documents(1500)) {
      const out = await writeLinks(
        payload(markdown, entries),
        write({ tree: () => fuzzTree, published: opened.open }),
      );
      if (out.markdown === markdown) continue;
      const before = tableWikilinks(markdown);
      const after = tableWikilinks(out.markdown);
      expect(after.length, markdown).toBe(before.length);
      let [from, to] = [0, 0];
      before.forEach((link, i) => {
        const now = after[i];
        if (!now) throw new Error('unreachable: same length');
        expect(out.markdown.slice(to, now.start), markdown).toBe(markdown.slice(from, link.start));
        if (now.source !== link.source) {
          renames++;
          if (now.property) inProperties++;
          else if (
            out.markdown[now.start - 1] !== '[' &&
            /=[ \t]*$/.test(out.markdown.slice(0, now.start))
          )
            inReferences++;
          expect({ heading: now.heading, shown: now.shown, embed: now.embed }, markdown).toEqual({
            heading: link.heading,
            shown: link.shown,
            embed: link.embed,
          });
          const title = TITLES.find(([, old]) =>
            link.target.trim().toLocaleLowerCase('en').endsWith(old.toLocaleLowerCase('en')),
          )?.[2];
          expect(title, markdown).toBeDefined();
          expect(now.target.endsWith(title ?? ''), markdown).toBe(true);
        }
        [from, to] = [link.end, now.end];
      });
      expect(out.markdown.slice(to), markdown).toBe(markdown.slice(from));
    }
    // The fuzz reaches renames, not only documents it leaves alone.
    expect(renames).toBeGreaterThan(300);
    expect(inProperties).toBeGreaterThan(50);
    expect(inReferences).toBeGreaterThan(50);
  }, 60_000);
});
