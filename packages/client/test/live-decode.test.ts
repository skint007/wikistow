// Strict decoding of live updates and states (protocol section 5.10): what
// Yjs writes in ordinary use decodes, and every form section 5.10 refuses is
// refused before any of it reaches Yjs.
import { describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import {
  coverage,
  decodeState,
  decodeUpdate,
  holdsState,
  sameState,
  type DecodedUpdate,
} from '../src/live/index.ts';
import { state, update, varuint, type Struct } from './support/yjs-bytes.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const one = (structs: Struct[], client = 7, clock = 0) =>
  update({ sections: [{ client, clock, structs }] });

// A seeded generator, so a failure repeats.
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

// Ordinary editing in a document of the session's shape, keeping each
// transaction's update, as an app does.
function edits(seed: number, count: number) {
  const next = random(seed);
  const doc = new Y.Doc();
  doc.clientID = 1000 + seed;
  const body = doc.getText('body');
  const extensions = doc.getMap<string>('extensions');
  const undo = new Y.UndoManager([body, extensions], { captureTimeout: 0 });
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  const words = ['a', 'ü', '😀', 'line\n', '\r\n', '﻿', 'tab\t'];
  for (let i = 0; i < count; i++) {
    const roll = next();
    const at = Math.floor(next() * (body.length + 1));
    if (roll < 0.5) body.insert(at, words[Math.floor(next() * words.length)] ?? 'x');
    else if (roll < 0.7 && body.length > 0) {
      const from = Math.min(at, body.length - 1);
      body.delete(from, Math.min(1 + Math.floor(next() * 3), body.length - from));
    } else if (roll < 0.85) extensions.set(`ns${Math.floor(next() * 3)}`, JSON.stringify(i));
    else if (roll < 0.92) extensions.delete(`ns${Math.floor(next() * 3)}`);
    else if (roll < 0.96) undo.undo();
    else undo.redo();
  }
  return { doc, updates };
}

const lengths = (decoded: DecodedUpdate) =>
  decoded.structs.map((section) => [section.client, section.start, section.end]);

describe('decoding updates', () => {
  it('reads what Yjs writes in ordinary editing, merged batches and whole documents', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { doc, updates } = edits(seed, 120);
      for (const u of updates) expect(() => decodeUpdate(u)).not.toThrow();
      const batch = Y.mergeUpdates(updates.slice(10, 30));
      expect(() => decodeUpdate(batch)).not.toThrow();
      const whole = decodeUpdate(Y.encodeStateAsUpdate(doc));
      const ys = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
      expect(whole.structs.flatMap((s) => s.items).length).toBe(ys.structs.length);
      expect(lengths(whole)[0]?.[2]).toBe(Y.getState(doc.store, doc.clientID));
    }
  });

  it('reads the empty update a save’s own join sends first', () => {
    expect(decodeUpdate(new Uint8Array([0, 0]))).toEqual({ structs: [], deletes: new Map() });
  });

  it('keeps a leading U+FEFF in a string, as lib0 reads it', () => {
    const decoded = decodeUpdate(one([{ content: { string: '﻿x' } }]));
    expect(decoded.structs[0]?.items[0]?.content).toEqual({ kind: 'string', text: '﻿x' });
    expect(decoded.structs[0]?.end).toBe(2);
  });

  it('counts strings in UTF-16 code units, and values one each', () => {
    const decoded = decodeUpdate(
      one([
        { content: { string: '😀é' } },
        { origin: { client: 7, clock: 2 }, content: { any: ['"a"', '"b"'] } },
      ]),
    );
    expect(decoded.structs[0]?.items.map((item) => item.length)).toEqual([3, 2]);
  });

  it('takes an item’s parent and key from its origin, whatever its parent-key flag says', () => {
    const doc = new Y.Doc();
    const map = doc.getMap<string>('extensions');
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    map.set('a', '"x"');
    map.set('a', '"y"');
    const second = decodeUpdate(updates[1] ?? new Uint8Array());
    expect(second.structs[0]?.items[0]).toMatchObject({ parent: null, parentSub: null });
  });

  it('refuses GC and skip structs', () => {
    expect(() => decodeUpdate(one([{ gc: 3 }]))).toThrow(code('binding-mismatch'));
    expect(() => decodeUpdate(one([{ skip: 3 }]))).toThrow(code('binding-mismatch'));
    // Yjs writes a skip when it merges updates with a gap between them.
    const { updates } = edits(3, 10);
    const gapped = Y.mergeUpdates([updates[0] ?? new Uint8Array(), updates[5] ?? new Uint8Array()]);
    expect(() => decodeUpdate(gapped)).toThrow(code('binding-mismatch'));
  });

  it('refuses every content but strings, deleted content and string values', () => {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    doc.getMap('extensions').set('nested', new Y.Map());
    doc.getText('body').insert(0, 'bold', { bold: true });
    doc.getText('body').insertEmbed(0, { image: 'x' });
    doc.getMap('fields').set('n', 1);
    doc.getMap('fields').set('b', new Uint8Array([1]));
    for (const u of updates) expect(() => decodeUpdate(u)).toThrow(code('binding-mismatch'));
    for (const raw of [2, 3, 5, 6, 7, 9, 11, 31]) {
      expect(() => decodeUpdate(one([{ content: { raw, bytes: [1, 1, 0x30] } }]))).toThrow(
        code('binding-mismatch'),
      );
    }
    expect(() => decodeUpdate(one([{ content: { any: ['"a"', 1] } }]))).toThrow(
      code('binding-mismatch'),
    );
  });

  it('refuses a parent by ID, and a root the document doesn’t have', () => {
    expect(() =>
      decodeUpdate(one([{ parent: { id: { client: 1, clock: 0 } }, content: { string: 'x' } }])),
    ).toThrow(code('binding-mismatch'));
    expect(() => decodeUpdate(one([{ parent: 'comments', content: { string: 'x' } }]))).toThrow(
      code('binding-mismatch'),
    );
    expect(() => decodeUpdate(one([{ parent: '__proto__', content: { string: 'x' } }]))).toThrow(
      code('binding-mismatch'),
    );
  });

  it('refuses an origin under its own client at or after its own clock', () => {
    for (const origin of [
      { client: 7, clock: 0 },
      { client: 7, clock: 5 },
    ]) {
      expect(() => decodeUpdate(one([{ origin, content: { string: 'x' } }]))).toThrow(
        code('binding-mismatch'),
      );
      expect(() => decodeUpdate(one([{ rightOrigin: origin, content: { string: 'x' } }]))).toThrow(
        code('binding-mismatch'),
      );
    }
    // Another client's, or its own earlier struct, is for the receiver to check.
    expect(() =>
      decodeUpdate(one([{ origin: { client: 7, clock: 2 }, content: { string: 'x' } }], 7, 3)),
    ).not.toThrow();
  });

  it('refuses length 0 anywhere', () => {
    expect(() => decodeUpdate(one([{ content: { string: '' } }]))).toThrow(
      code('binding-mismatch'),
    );
    expect(() => decodeUpdate(one([{ content: { deleted: 0 } }]))).toThrow(
      code('binding-mismatch'),
    );
    expect(() => decodeUpdate(one([{ content: { any: [] } }]))).toThrow(code('binding-mismatch'));
    expect(() => decodeUpdate(update({ deletes: [{ client: 1, ranges: [[0, 0]] }] }))).toThrow(
      code('binding-mismatch'),
    );
    expect(() => decodeUpdate(update({ deletes: [{ client: 1, ranges: [] }] }))).toThrow(
      code('binding-mismatch'),
    );
    expect(() =>
      decodeUpdate(update({ sections: [{ client: 1, clock: 0, structs: [] }] })),
    ).toThrow(code('binding-mismatch'));
  });

  it('refuses a client twice among the structs, or twice in the delete set', () => {
    const s: Struct = { content: { string: 'x' } };
    expect(() =>
      decodeUpdate(
        update({
          sections: [
            { client: 1, clock: 0, structs: [s] },
            { client: 1, clock: 1, structs: [s] },
          ],
        }),
      ),
    ).toThrow(code('binding-mismatch'));
    expect(() =>
      decodeUpdate(
        update({
          deletes: [
            { client: 1, ranges: [[0, 1]] },
            { client: 1, ranges: [[2, 1]] },
          ],
        }),
      ),
    ).toThrow(code('binding-mismatch'));
  });

  it('refuses bytes after the end, a short update, and numbers not written minimally', () => {
    const good = one([{ content: { string: 'x' } }]);
    expect(() => decodeUpdate(new Uint8Array([...good, 0]))).toThrow(code('binding-mismatch'));
    expect(() => decodeUpdate(good.slice(0, -1))).toThrow(code('binding-mismatch'));
    // The client 7 as 0x87 0x00.
    const padded = new Uint8Array([
      1,
      1,
      0x87,
      0,
      0,
      4,
      1,
      4,
      ...new TextEncoder().encode('body'),
      1,
      0x78,
      0,
    ]);
    expect(() => decodeUpdate(padded)).toThrow(code('binding-mismatch'));
    expect(varuint(128)).toEqual([0x80, 1]);
    // A number past 2^53 − 1.
    const huge = new Uint8Array([1, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(() => decodeUpdate(huge)).toThrow(code('binding-mismatch'));
  });

  it('refuses a string that isn’t UTF-8', () => {
    const bad = one([{ content: { raw: 4, bytes: [2, 0xc3, 0x28] } }]);
    expect(() => decodeUpdate(bad)).toThrow(code('binding-mismatch'));
  });
});

describe('states', () => {
  it('decodes what Y.encodeSnapshot writes, and compares by what it covers', () => {
    const { doc } = edits(5, 200);
    const decoded = decodeState(Y.encodeSnapshot(Y.snapshot(doc)));
    expect(decoded?.vector.get(doc.clientID)).toBe(Y.getState(doc.store, doc.clientID));
    // One delete set cut two ways is one state.
    const a = decodeState(state({ deletes: [{ client: 1, ranges: [[0, 4]] }], vector: [[1, 9]] }));
    const b = decodeState(
      state({
        deletes: [
          {
            client: 1,
            ranges: [
              [2, 2],
              [0, 2],
            ],
          },
        ],
        vector: [[1, 9]],
      }),
    );
    expect(a && b && sameState(a, b)).toBe(true);
    const c = decodeState(state({ deletes: [{ client: 1, ranges: [[0, 3]] }], vector: [[1, 9]] }));
    expect(a && c && holdsState(a, c)).toBe(true);
    expect(a && c && holdsState(c, a)).toBe(false);
    const d = decodeState(
      state({
        vector: [
          [1, 9],
          [2, 1],
        ],
      }),
    );
    expect(a && d && holdsState(a, d)).toBe(false);
    expect(
      coverage([
        { clock: 5, length: 1 },
        { clock: 0, length: 5 },
      ]),
    ).toEqual([{ clock: 0, length: 6 }]);
  });

  it('counts a state that doesn’t decode strictly as none', () => {
    for (const bad of [
      state({ vector: [[1, 0]] }),
      state({
        vector: [
          [1, 2],
          [1, 3],
        ],
      }),
      state({ deletes: [{ client: 1, ranges: [] }] }),
      state({ deletes: [{ client: 1, ranges: [[0, 0]] }] }),
      new Uint8Array([...state({ vector: [[1, 2]] }), 0]),
      new Uint8Array([0]),
    ]) {
      expect(decodeState(bad)).toBeNull();
    }
  });
});
