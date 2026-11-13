// A live session's document (protocol section 5.10, **The document**): the
// checks as Yjs places each struct, the payload a save writes from it, and
// how two payloads compare.
import { describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import { newPayload, type AttachmentRef, type PagePayload } from '../src/index.ts';
import {
  documentFromPayload,
  joinMarkdown,
  jsonEqual,
  LiveDocument,
  samePayload,
} from '../src/live/index.ts';
import { update, type Struct } from './support/yjs-bytes.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const one = (structs: Struct[], client = 7) =>
  update({ sections: [{ client, clock: 0, structs }] });
const placed = (bytes: Uint8Array) => new LiveDocument(99).apply(bytes).map((m) => m.why);
const ref = (id: string, extra: Record<string, unknown> = {}): AttachmentRef => ({
  id: id as AttachmentRef['id'],
  name: `${id}.png`,
  mediaType: 'image/png',
  size: 3,
  key: 'a2V5',
  blobHash: 'B'.repeat(42) + 'A',
  ...extra,
});
const entry = (parentSub: string, value: string, parent = 'extensions'): Struct => ({
  parent,
  parentSub,
  content: { any: [value] },
});

describe('placing structs', () => {
  it('places ordinary text and values', () => {
    expect(placed(one([{ parent: 'title', content: { string: 'Hi' } }]))).toEqual([]);
    expect(placed(one([entry('ns', '{"a":[1,2]}')]))).toEqual([]);
    expect(placed(one([entry('a', JSON.stringify(ref('a')), 'attachments')]))).toEqual([]);
    expect(placed(one([entry('wiki', '"page-id"', 'links')]))).toEqual([]);
    expect(placed(one([entry('future', '[true]', 'fields')]))).toEqual([]);
    expect(
      placed(
        one([entry('rev', JSON.stringify({ revision: 'rev', parts: ['title'] }), 'overlaps')]),
      ),
    ).toEqual([]);
  });

  it('refuses text under a map key, and a map value with none', () => {
    expect(placed(one([{ parent: 'title', parentSub: 'k', content: { string: 'x' } }]))).toEqual([
      'text under a map key',
    ]);
    expect(placed(one([{ parent: 'extensions', content: { any: ['"x"'] } }]))).toEqual([
      'a map value with no key',
    ]);
  });

  it('refuses content of the wrong kind for its part', () => {
    expect(placed(one([{ parent: 'body', content: { any: ['"x"'] } }]))).toEqual([
      'something other than text in a text part',
    ]);
    expect(placed(one([{ parent: 'fields', parentSub: 'k', content: { string: '"x"' } }]))).toEqual(
      ['something other than a string in a map'],
    );
  });

  it('refuses a map value that isn’t JSON of its kind', () => {
    const problems = [
      entry('ns', '{'),
      entry('ns', '{"a":1,"a":2}'),
      entry('ns', '"\\ud800"'),
      entry('ns', '1e999'),
      entry('wikistow.cover', '{"format":1.0}'),
      entry('a', JSON.stringify(ref('b')), 'attachments'),
      entry('a', JSON.stringify({ ...ref('a'), size: 1.5 }), 'attachments'),
      entry('a', '{"id":"a"}', 'attachments'),
      entry('wiki', '42', 'links'),
      entry('rev', JSON.stringify({ revision: 'other', parts: ['title'] }), 'overlaps'),
      entry('rev', JSON.stringify({ revision: 'rev', parts: [] }), 'overlaps'),
      entry('title', '"x"', 'fields'),
      entry('format', '{}', 'fields'),
    ];
    for (const problem of problems) expect(placed(one([problem]))).toHaveLength(1);
    // A namespace whose integers the payload doesn't type takes any number.
    expect(placed(one([entry('ns', '{"format":1.0}')]))).toEqual([]);
  });

  it('refuses the extensions a save works out, which the document never holds', () => {
    for (const namespace of [
      'wikistow.live',
      'wikistow.links',
      'wikistow.change',
      'wikistow.overlaps',
    ]) {
      expect(placed(one([entry(namespace, '{}')]))).toHaveLength(1);
    }
  });

  it('counts a value’s nesting at the depth it will have in the payload', () => {
    const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(placed(one([entry('ns', nested(255))]))).toEqual([]);
    expect(placed(one([entry('ns', nested(256))]))).toHaveLength(1);
  });

  it('checks the value Yjs reads, and lets deleted content be', () => {
    expect(
      placed(one([{ parent: 'extensions', parentSub: 'k', content: { any: ['{', '"ok"'] } }])),
    ).toEqual([]);
    const deleted = update({
      sections: [{ client: 7, clock: 0, structs: [entry('k', '{')] }],
      deletes: [{ client: 7, ranges: [[0, 1]] }],
    });
    expect(placed(deleted)).toEqual([]);
    expect(
      placed(one([{ parent: 'extensions', parentSub: 'k', content: { deleted: 2 } }])),
    ).toEqual([]);
  });

  it('refuses an item whose two origins are under different parents, or are one', () => {
    const across = one([
      { parent: 'title', content: { string: 'a' } },
      { parent: 'body', content: { string: 'b' } },
      {
        origin: { client: 7, clock: 0 },
        rightOrigin: { client: 7, clock: 1 },
        content: { string: 'c' },
      },
    ]);
    expect(placed(across)).toContain('its origins are under different parents or keys');
    const keys = one([
      entry('a', '"1"'),
      entry('b', '"2"'),
      {
        origin: { client: 7, clock: 0 },
        rightOrigin: { client: 7, clock: 1 },
        content: { any: ['"3"'] },
      },
    ]);
    expect(placed(keys)).toContain('its origins are under different parents or keys');
  });

  it('says when Yjs gave the document a new client ID', () => {
    const document = new LiveDocument(7);
    const found = document.apply(one([{ parent: 'body', content: { string: 'mine?' } }]));
    expect(found.map((m) => m.why)).toContain('Yjs changed this join’s client ID');
  });

  it('checks structs Yjs held back as it places them later', () => {
    const document = new LiveDocument(99);
    const later = update({
      sections: [
        {
          client: 7,
          clock: 1,
          structs: [{ origin: { client: 7, clock: 0 }, content: { any: ['{'] } }],
        },
      ],
    });
    expect(document.apply(later)).toEqual([]);
    expect(document.pending).toBe(true);
    const first = one([entry('k', '"ok"')]);
    expect(document.apply(first).map((m) => m.why)).toEqual(['an extension value that isn’t JSON']);
    expect(document.pending).toBe(false);
  });
});

describe('the payload a save writes', () => {
  const draft = {
    ...newPayload({
      title: 'Lasagne',
      markdown: '---\r\ntags: [dinner]\r\n---\r\nBrown the mince.',
      attachments: [ref('b'), ref('a')],
      extensions: { 'wikistow.cover': { format: 1, icon: '🍝' }, 'wikistow.links': [] },
    }),
    future: { kept: true },
  } as PagePayload;
  Object.defineProperty(draft.extensions, '__proto__', {
    value: { odd: 1 },
    enumerable: true,
    writable: true,
    configurable: true,
  });

  it('writes the draft the document started from back as it was', () => {
    const document = documentFromPayload(draft, 7);
    expect(document.content().frontmatter).toBe('---\r\ntags: [dinner]\r\n---\r\n');
    const written = document.payload(draft);
    expect(written.markdown).toBe(draft.markdown);
    expect(written.attachments.map((a) => a.id)).toEqual(['b', 'a']);
    expect(Object.hasOwn(written.extensions, '__proto__')).toBe(true);
    expect(Object.hasOwn(written.extensions, 'wikistow.links')).toBe(false);
    expect((written as Record<string, unknown>).future).toEqual({ kept: true });
    expect(samePayload(written, draft)).toBe(true);
  });

  it('starts nothing from a draft that equals no document', () => {
    const twice = { ...draft, attachments: [ref('a'), ref('a')] };
    expect(() => documentFromPayload(twice, 7)).toThrow(code('malformed'));
    const notes = {
      ...draft,
      extensions: {
        'wikistow.overlaps': {
          format: 1,
          revisions: [
            { revision: 'r', parts: ['title'] },
            { revision: 'r', parts: ['icon'] },
          ],
        },
      },
    };
    expect(() => documentFromPayload(notes, 7)).toThrow(code('malformed'));
  });

  it('writes overlaps notes in code-unit order, only when there are any', () => {
    const document = new LiveDocument(7);
    document.edit(() => {
      document.map('overlaps').set('b', JSON.stringify({ revision: 'b', parts: ['title'] }));
      document.map('overlaps').set('B', JSON.stringify({ revision: 'B', parts: ['body:0-1'] }));
    });
    const written = document.payload();
    expect(written.extensions['wikistow.overlaps']).toEqual({
      format: 1,
      revisions: [
        { revision: 'B', parts: ['body:0-1'] },
        { revision: 'b', parts: ['title'] },
      ],
    });
    expect(new LiveDocument(8).payload().extensions).toEqual({});
  });

  it('puts attachments the base had first, in its order, then new ones', () => {
    const document = new LiveDocument(7);
    document.edit(() => {
      for (const id of ['n', 'a', 'b'])
        document.map('attachments').set(id, JSON.stringify(ref(id)));
    });
    expect(document.payload(draft).attachments.map((a) => a.id)).toEqual(['b', 'a', 'n']);
  });

  it('joins front matter and body as the app does', () => {
    expect(joinMarkdown('', 'body')).toBe('body');
    expect(joinMarkdown('---\n---\n', 'body')).toBe('---\n---\nbody');
    expect(joinMarkdown('---\n---', 'body')).toBe('---\n---\nbody');
    expect(joinMarkdown('---\r\nx\r\n---', 'body')).toBe('---\r\nx\r\n---\r\nbody');
    expect(joinMarkdown('---\n---', '')).toBe('---\n---');
  });
});

describe('comparing payloads', () => {
  const base = newPayload({ title: 'T', markdown: 'M', attachments: [ref('a'), ref('b')] });

  it('compares attachments as a set of whole refs, and members in any order', () => {
    const turned = { ...base, attachments: [ref('b'), ref('a')], extensions: {} };
    expect(samePayload(turned, base)).toBe(true);
    expect(samePayload({ ...base, attachments: [ref('a'), ref('b', { size: 4 })] }, base)).toBe(
      false,
    );
    expect(samePayload({ ...base, attachments: [ref('a'), ref('a')] }, base)).toBe(false);
    expect(jsonEqual({ a: 1, b: [1, { c: -0 }] }, { b: [1, { c: 0 }], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });

  it('leaves aside the format, the link table, wikistow.live and wikistow.change', () => {
    const draft = {
      ...base,
      format: { major: 1 as const, minor: 9 },
      extensions: {
        'wikistow.links': [{ text: 'x', target: 'y' }],
        'wikistow.live': { format: 1 },
        'wikistow.change': { format: 1 },
      },
    };
    expect(samePayload(base, draft)).toBe(true);
    expect(samePayload(base, { ...draft, extensions: { other: 1 } })).toBe(false);
    expect(samePayload(base, { ...base, title: 'Other' })).toBe(false);
  });

  it('repairs the draft first, as a save repairs it', () => {
    expect(samePayload({ ...base, title: 'Cut \uFFFD' }, { ...base, title: 'Cut \ud83d' })).toBe(
      true,
    );
  });

  it('compares overlaps notes as a set, an empty or broken one as none', () => {
    const notes = (revisions: unknown) =>
      ({
        ...base,
        extensions: { 'wikistow.overlaps': { format: 1, revisions } },
      }) as PagePayload;
    const a = { revision: 'a', parts: ['title'] };
    const b = { revision: 'b', parts: ['icon'] };
    expect(samePayload(notes([a, b]), notes([b, a]))).toBe(true);
    expect(samePayload(base, notes([]))).toBe(true);
    expect(samePayload(base, { ...base, extensions: { 'wikistow.overlaps': 'broken' } })).toBe(
      true,
    );
    expect(samePayload(notes([a]), notes([a, a]))).toBe(false);
    expect(samePayload(notes([a]), notes([b]))).toBe(false);
    // A newer format is carried unchanged, while the document holds none of its own.
    const newer = { ...base, extensions: { 'wikistow.overlaps': { format: 2 } } };
    expect(samePayload(base, newer)).toBe(true);
    expect(samePayload(notes([a]), newer)).toBe(false);
  });
});

describe('reading the document', () => {
  it('reads maps entry by entry, keeping a __proto__ key', () => {
    const document = new LiveDocument(7);
    document.edit(() => document.map('extensions').set('__proto__', '{"x":1}'));
    expect([...document.content().extensions]).toEqual([['__proto__', '{"x":1}']]);
    expect(Object.hasOwn(document.payload().extensions, '__proto__')).toBe(true);
    expect(Y.getState(document.doc.store, 7)).toBe(1);
  });
});
