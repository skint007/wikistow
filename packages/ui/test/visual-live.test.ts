import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import { blockAt, barsOf } from '../src/page/editor/visual/live-bars.ts';
import {
  TAKE_MS,
  VisualBinding,
  WHOLE_MS,
  type BoundEditor,
  type Taking,
} from '../src/page/editor/visual/live-binding.ts';
import { applyTo, Mapping, ownChanges, putInto } from '../src/page/editor/visual/live-text.ts';

// The visual editor in a live session (ADR 0015 decision 3): its own edits
// go into `body` as the blocks it changed, carried through others' changes
// it hasn't taken in yet; others' changes go in by block, together within a
// tenth of a second, a composition waiting, and a change past its block read
// whole at its pace.

// Timers due now, and the promises they settle: a timer set for 0 ms
// waits for the next millisecond of the fake clock.
async function settle() {
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const own = (before: string, after: string) => applyTo(before, ownChanges(before, after));

describe('its own edits', () => {
  it('changes only the runs of lines that differ, each by its smallest change', () => {
    const before = 'One.\n\nTwo.\n\nThree.\n';
    const after = 'One!\n\nTwo.\n\nThree!\n';
    const changes = ownChanges(before, after);
    expect(changes).toEqual([
      { from: 3, remove: 1, insert: '!' },
      { from: 17, remove: 1, insert: '!' },
    ]);
    expect(own(before, after)).toBe(after);
  });

  it('adds at a line’s end and on a later line as two insertions, nothing between rewritten', () => {
    const before = 'One sentence.\n\nSam wrote this paragraph.\n';
    const after = 'One sentence. More.\n\nSam wrote this paragraph. Yes.\n';
    expect(ownChanges(before, after)).toEqual([
      { from: 13, remove: 0, insert: ' More.' },
      { from: 40, remove: 0, insert: ' Yes.' },
    ]);
    expect(own(before, after)).toBe(after);
  });

  it('changes a page that starts with a blank line from its very start', () => {
    for (const [before, after] of [
      ['\n# Title\n', '# Title\n'],
      ['\nHello', 'Hello'],
      ['\n\nA\n', 'A\n'],
      ['\n# Title\n\nBody', 'Intro\n\n# Title\n\nBody'],
    ] as const)
      expect(own(before, after)).toBe(after);
  });

  it('makes every text the other, at random', () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const alphabet = ['a', 'b', ' ', '\n', '\r\n', '😀', '#', '*'];
    const text = () =>
      Array.from({ length: Math.floor(next() * 12) }, () => alphabet[Math.floor(next() * 8)]).join(
        '',
      );
    for (let i = 0; i < 2_000; i++) {
      const [before, after] = [text(), text()];
      const result = own(before, after);
      expect(result).toBe(after);
    }
  });

  it('never starts or ends a change inside an emoji’s two halves', () => {
    // 😀 and 😁 share their first half: a change by code unit would start between them.
    const before = 'A 😀 b';
    const after = 'A 😁 b';
    const [change] = ownChanges(before, after);
    expect(change).toEqual({ from: 2, remove: 2, insert: '😁' });
    expect(own(before, after)).toBe(after);
  });

  it('keeps a CRLF page’s line breaks as they are', () => {
    const before = 'One.\r\n\r\nTwo.\r\n';
    const after = 'One.\r\n\r\nTwo, three.\r\n';
    expect(ownChanges(before, after)).toEqual([{ from: 11, remove: 0, insert: ', three' }]);
    expect(own(before, after)).toBe(after);
  });
});

describe('carried onto body', () => {
  it('keeps both people’s typing in one block', () => {
    const held = 'The cat sat.\n';
    const body = 'The black cat sat.\n';
    const next = 'The cat sat down.\n';
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    expect(applyTo(body, carried)).toBe('The black cat sat down.\n');
  });

  it('leaves what someone else added inside a range it deletes', () => {
    const held = 'one two four\n';
    const body = 'one two-and-a-half four\n';
    const next = 'one four\n';
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    // "two " goes, by character, and what Sam typed after "two" stays.
    expect(applyTo(body, carried)).toBe('one -and-a-halffour\n');
  });

  it('doesn’t take out again what someone else took out', () => {
    const held = 'hello world\n';
    const body = 'hello ld\n';
    const next = 'hello there\n';
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    expect(applyTo(body, carried)).toBe('hello there\n');
  });

  it('puts two blocks’ changes each where its block is now', () => {
    const held = 'A.\n\nB.\n\nC.\n';
    const body = 'A.\n\nB, by Sam.\n\nC.\n';
    const next = 'A!\n\nB.\n\nC!\n';
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    expect(applyTo(body, carried)).toBe('A!\n\nB, by Sam.\n\nC!\n');
  });

  it('carries emoji through others’ emoji, whole', () => {
    const held = '😀 a\n';
    const body = '😀😁 a\n';
    const next = '😀 ab\n';
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    const result = applyTo(body, carried);
    expect(result).toBe('😀😁 ab\n');
    expect(result.isWellFormed()).toBe(true);
  });

  it('leaves someone’s deletion between two changes in one line', () => {
    const held = 'The quick brown fox.\n';
    const body = 'The brown fox.\n';
    const next = 'A quick brown dog.\n';
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    expect(applyTo(body, carried)).toBe('A brown dog.\n');
  });

  it('stops following changes past a bound, for a diff to stand in', () => {
    const delta = Array.from({ length: 3_000 }, () => [{ retain: 1 }, { insert: 'x' }]).flat();
    expect(Mapping.identity(3_000).remote(delta)).toBe(null);
    expect(Mapping.identity(10).remote([{ retain: 2 }, { insert: 'x' }])?.bodyLength).toBe(11);
  });

  it('doesn’t join two changes over characters someone else changed between them', () => {
    const held = 'x a-b y\n';
    const body = 'x ab y\n';
    const next = 'x A-B y\n';
    const mapping = Mapping.between(held, body);
    const changes = ownChanges(held, next, (from, to) => mapping.untouched(from, to));
    expect(applyTo(body, mapping.carry(changes))).toBe('x AB y\n');
  });

  it('maps places both ways', () => {
    const mapping = Mapping.between('abc def', 'abc XX def');
    expect(mapping.toBody(4)).toBe(7);
    expect(mapping.toHeld(7)).toBe(4);
    expect(mapping.toHeld(5)).toBe(4);
  });

  it('puts the changes into a Y.Text, from the last', () => {
    const doc = new Y.Doc();
    const text = doc.getText('body');
    text.insert(0, 'One.\n\nTwo.\n');
    putInto(text, ownChanges('One.\n\nTwo.\n', 'One!\n\nTwo!\n'));
    expect(text.toJSON()).toBe('One!\n\nTwo!\n');
  });
});

describe('bars by the block', () => {
  const runs = [
    { first: 0, count: 1, from: 0, to: 4 },
    { first: 1, count: 2, from: 6, to: 20 },
  ];
  const spans = [{ from: 0, to: 4 }, null, null];
  it('finds the block an offset is in, or the next', () => {
    expect(blockAt(runs, spans, 3, 2)).toBe(0);
    expect(blockAt(runs, spans, 3, 10)).toBe(1);
    expect(blockAt(runs, spans, 3, 5)).toBe(1);
    expect(blockAt(runs, spans, 3, 99)).toBe(2);
    expect(blockAt(runs, spans, 0, 1)).toBe(null);
  });
  it('puts a block’s people together, in the colour of the first', () => {
    const bars = barsOf(
      [
        { key: 'a', name: 'Sam', colour: 1, at: 1 },
        { key: 'b', name: 'Rita', colour: 2, at: 2 },
        { key: 'c', name: 'Ola', colour: 3, at: 10 },
      ],
      (at) => blockAt(runs, spans, 3, at),
    );
    expect(bars).toEqual([
      { index: 0, colour: 1, names: ['Sam', 'Rita'] },
      { index: 1, colour: 3, names: ['Ola'] },
    ]);
  });
});

// A visual editor that shows what it takes in, and writes what it shows.
class FakeEditor implements BoundEditor {
  shown: string;
  taken: string[] = [];
  wholes: string[] = [];
  checks: string[] = [];
  composing = false;
  byBlock = true;
  /** Block take-ins checked off the thread, failing after this long. */
  asyncTakeMs: number | null = null;
  visual = true;
  checkMs = 0;
  cantShows: (readonly (string | null)[])[] = [];
  canShows = 0;
  constructor(text: string) {
    this.shown = text;
  }
  written() {
    return this.shown;
  }
  take(text: string): Taking | Promise<Taking> {
    if (this.asyncTakeMs !== null)
      return new Promise((resolve) => setTimeout(() => resolve(false), this.asyncTakeMs ?? 0));
    if (this.composing) return 'composing';
    if (!this.byBlock) return false;
    this.taken.push(text);
    this.shown = text;
    return true;
  }
  show(text: string): true | 'composing' {
    if (this.composing) return 'composing';
    this.wholes.push(text);
    this.shown = text;
    return true;
  }
  check(text: string) {
    this.checks.push(text);
    return new Promise<{ visual: boolean; reason: string | null }>((resolve) =>
      setTimeout(() => resolve({ visual: this.visual, reason: 'raw HTML' }), this.checkMs),
    );
  }
  cantShow(by: readonly (string | null)[]) {
    this.cantShows.push(by);
  }
  canShow() {
    this.canShows++;
  }
}

describe('the binding', () => {
  const LOCAL = Symbol('local');
  let doc: Y.Doc;
  let text: Y.Text;
  let remote: Y.Doc;
  let before: Set<(sender: string) => void>;
  let editor: FakeEditor;
  let binding: VisualBinding;
  let active: boolean;

  // Someone else's change, as the participant applies it: its listeners hear first.
  const theirs = (sender: string, change: (text: Y.Text) => void) => {
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(remote)));
    change(remote.getText('body'));
    const update = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc));
    for (const listener of before) listener(sender);
    Y.applyUpdate(doc, update, 'remote');
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    doc = new Y.Doc();
    text = doc.getText('body');
    text.insert(0, 'One.\n\nTwo.\n');
    remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    before = new Set();
    editor = new FakeEditor('One.\n\nTwo.\n');
    active = true;
    binding = new VisualBinding(
      {
        text,
        edit: (change) => {
          if (active) doc.transact(change, LOCAL);
        },
        onBeforeRemote: (listener) => {
          before.add(listener);
          return () => void before.delete(listener);
        },
        active: () => active,
      },
      editor,
    );
  });
  afterEach(() => {
    binding.destroy();
    vi.useRealTimers();
  });

  it('writes its own edit into body as the blocks it changed', () => {
    editor.shown = 'One.\n\nTwo!\n';
    expect(binding.write()).toBe('One.\n\nTwo!\n');
    expect(text.toJSON()).toBe('One.\n\nTwo!\n');
  });

  it('takes changes arriving within a tenth of a second in together', async () => {
    theirs('sam', (body) => body.insert(4, ' Sam'));
    await vi.advanceTimersByTimeAsync(TAKE_MS / 2);
    theirs('rita', (body) => body.insert(body.length - 1, ' Rita'));
    expect(editor.taken).toEqual([]);
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    expect(editor.taken).toEqual(['One. Sam\n\nTwo. Rita\n']);
  });

  it('writes its unreported edit before someone else’s change goes in', () => {
    editor.shown = 'One!\n\nTwo.\n';
    theirs('sam', (body) => body.insert(body.length - 1, ' Sam'));
    expect(text.toJSON()).toBe('One!\n\nTwo. Sam\n');
  });

  it('carries an edit made before it took in someone else’s change', async () => {
    theirs('sam', (body) => body.insert(4, ' Sam'));
    // Typed in the tenth of a second before it took theirs in.
    editor.shown = 'One!\n\nTwo.\n';
    binding.write();
    expect(text.toJSON()).toBe('One! Sam\n\nTwo.\n');
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    expect(editor.shown).toBe('One! Sam\n\nTwo.\n');
  });

  it('waits for a composition to end', async () => {
    editor.composing = true;
    theirs('sam', (body) => body.insert(4, ' Sam'));
    await vi.advanceTimersByTimeAsync(TAKE_MS * 3);
    expect(editor.shown).toBe('One.\n\nTwo.\n');
    editor.composing = false;
    binding.composed();
    expect(editor.shown).toBe('One. Sam\n\nTwo.\n');
  });

  it('reads a change that reaches past its block whole, at most every second', async () => {
    editor.byBlock = false;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    expect(editor.checks).toHaveLength(1);
    await settle();
    expect(editor.wholes).toEqual(['```\nOne.\n\nTwo.\n']);
    theirs('sam', (body) => body.insert(4, 'a'));
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    // Not yet: a second from the last whole read.
    expect(editor.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WHOLE_MS);
    expect(editor.checks).toHaveLength(2);
    await settle();
    expect(editor.shown).toBe('```\naOne.\n\nTwo.\n');
  });

  it('paces whole reads at twice as long as the last took', async () => {
    editor.byBlock = false;
    editor.checkMs = 800;
    theirs('sam', (body) => body.insert(0, '<div>\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    // The read starts now, and takes 0.8 s.
    const started = performance.now();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(editor.wholes).toHaveLength(1);
    theirs('sam', (body) => body.insert(0, 'x'));
    // Past a second from its start, but not 1.6 s: not yet.
    await vi.advanceTimersByTimeAsync(started + 1_500 - performance.now());
    expect(editor.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(editor.checks).toHaveLength(2);
  });

  it('keeps typing that came during a whole read', async () => {
    editor.byBlock = false;
    editor.checkMs = 500;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS + 100);
    editor.shown = 'One.\n\nTwo!\n';
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(text.toJSON()).toBe('```\nOne.\n\nTwo!\n');
    // Only the person changed it meanwhile: what the editor wrote goes in with what was checked.
    expect(editor.checks).toEqual(['```\nOne.\n\nTwo.\n']);
    expect(editor.wholes).toEqual(['```\nOne.\n\nTwo!\n']);
    expect(editor.shown).toBe('```\nOne.\n\nTwo!\n');
  });

  it('shows its own typing during a whole read, which nobody else changed', async () => {
    editor.byBlock = false;
    editor.checkMs = 300;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS + 100);
    editor.shown = 'One.\n\nTwo!\n';
    binding.write();
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(editor.checks).toHaveLength(1);
    expect(editor.shown).toBe('```\nOne.\n\nTwo!\n');
  });

  it('never hides the person’s typing when others type through every check too', async () => {
    editor.byBlock = false;
    editor.checkMs = 300;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(150);
      theirs('sam', (body) => body.insert(body.length, String(i)));
      editor.shown = editor.shown.replace('Two', `Two${i}`);
      binding.write();
      await vi.advanceTimersByTimeAsync(150);
      await settle();
      expect(editor.shown).toContain(`Two${i}`);
    }
    expect(editor.wholes).toEqual([]);
    // Once others pause, it catches up.
    await vi.advanceTimersByTimeAsync(WHOLE_MS * 3);
    await settle();
    expect(editor.shown).toBe(text.toJSON());
  });

  it('shows only text it checked, while others type on through every check', async () => {
    editor.byBlock = false;
    editor.checkMs = 300;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(150);
      theirs('sam', (body) => body.insert(body.length, String(i)));
      await vi.advanceTimersByTimeAsync(150);
      await settle();
    }
    // Three checks, each of newer text, then the last one checked goes in.
    expect(editor.checks).toHaveLength(3);
    expect(editor.wholes).toEqual([editor.checks[2]]);
    expect(text.toJSON()).not.toBe(editor.checks[2]);
    // The rest follows, checked in turn.
    await vi.advanceTimersByTimeAsync(WHOLE_MS * 3);
    await settle();
    expect(editor.shown).toBe(text.toJSON());
  });

  it('says who added what it can’t show, and when it can again', async () => {
    editor.byBlock = false;
    editor.visual = false;
    theirs('sam', (body) => body.insert(0, '<b>\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS + 1);
    await settle();
    expect(editor.cantShows).toEqual([['sam']]);
    editor.visual = true;
    editor.byBlock = true;
    theirs('rita', (body) => body.delete(0, 4));
    await vi.advanceTimersByTimeAsync(WHOLE_MS + TAKE_MS);
    await settle();
    expect(editor.canShows).toBe(1);
    expect(editor.shown).toBe('One.\n\nTwo.\n');
  });

  it('checks body as it is when a whole read starts, after a take-in checked off the thread', async () => {
    editor.asyncTakeMs = 200;
    editor.visual = false;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS + 50);
    theirs('rita', (body) => body.insert(body.length, '<div>raw</div>\n'));
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(editor.checks).toEqual(['```\nOne.\n\nTwo.\n<div>raw</div>\n']);
    expect(editor.wholes).toEqual([]);
    expect(editor.cantShows).toEqual([['sam', 'rita']]);
  });

  it('names nobody for the person’s own change from elsewhere', async () => {
    editor.byBlock = false;
    editor.visual = false;
    doc.transact(() => text.insert(0, '<b>\n'), LOCAL);
    await vi.advanceTimersByTimeAsync(TAKE_MS + 1);
    await settle();
    expect(editor.cantShows).toEqual([[null]]);
  });

  it('names everyone who changed it since it could show it, never a sender gone before', async () => {
    editor.byBlock = false;
    editor.visual = false;
    // Sam's change that touches only the title primes nobody.
    for (const listener of before) listener('sam');
    doc.transact(() => doc.getText('title').insert(0, 'T'), 'remote');
    doc.transact(() => text.insert(0, '<b>\n'), LOCAL);
    theirs('rita', (body) => body.insert(body.length, ' Rita'));
    await vi.advanceTimersByTimeAsync(TAKE_MS + 1);
    await settle();
    expect(editor.cantShows).toEqual([[null, 'rita']]);
  });

  it('takes nothing in over typing once the session is left', async () => {
    theirs('sam', (body) => body.insert(0, 'Sam. '));
    editor.shown = 'One.\n\nTwo!\n';
    active = false;
    expect(binding.write()).toBe('Sam. One.\n\nTwo!\n');
    await vi.advanceTimersByTimeAsync(TAKE_MS * 3);
    expect(editor.taken).toEqual([]);
    expect(editor.shown).toBe('One.\n\nTwo!\n');
  });

  it('doesn’t take its own writes back in', async () => {
    editor.shown = 'One.\n\nTwo!\n';
    binding.write();
    await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    expect(editor.taken).toEqual([]);
  });

  it('carries its edit by how Yjs said body changed, never deleting what someone else put in', () => {
    text.delete(0, text.length);
    text.insert(0, 'fix teh typo\n');
    editor.shown = 'fix teh typo\n';
    binding.destroy();
    binding = new VisualBinding(
      {
        text,
        edit: (change) => doc.transact(change, LOCAL),
        onBeforeRemote: (listener) => {
          before.add(listener);
          return () => void before.delete(listener);
        },
        active: () => true,
      },
      editor,
    );
    // Sam puts "the" in place of "teh"; a diff would line his "e" up with the old one.
    theirs('sam', (body) => {
      body.delete(4, 3);
      body.insert(4, 'the');
    });
    // Before it takes his in, the person deletes "teh".
    editor.shown = 'fix  typo\n';
    binding.write();
    expect(text.toJSON()).toBe('fix the typo\n');
  });

  it('keeps everything someone else put in, whatever the person changes meanwhile', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = (n: number) => Math.floor(next() * n);
    for (let round = 0; round < 300; round++) {
      text.delete(0, text.length);
      text.insert(0, 'ab cd\nef gh\n');
      editor.shown = text.toJSON();
      binding.destroy();
      binding = new VisualBinding(
        {
          text,
          edit: (change) => doc.transact(change, LOCAL),
          onBeforeRemote: () => () => {},
          active: () => true,
        },
        editor,
      );
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(remote)));
      // Someone's changes, each mark one nobody else types.
      const marks: string[] = [];
      for (let i = 0; i < 1 + pick(3); i++) {
        theirs('sam', (body) => {
          const at = pick(body.length + 1);
          if (next() < 0.4 && body.length > 0)
            body.delete(Math.min(at, body.length - 1), 1 + pick(2));
          const mark = String.fromCharCode(65 + marks.length);
          marks.push(mark);
          body.insert(Math.min(at, body.length), mark);
        });
      }
      const kept = marks.filter((mark) => text.toJSON().includes(mark));
      // The person's: a few deletions and lower-case typing, of what the editor shows.
      let shown = editor.shown;
      for (let i = 0; i < 1 + pick(3); i++) {
        const from = pick(shown.length + 1);
        const to = Math.min(shown.length, from + pick(4));
        shown = shown.slice(0, from) + 'xyz'.slice(0, pick(3)) + shown.slice(to);
      }
      editor.shown = shown;
      binding.write();
      for (const mark of kept) expect(text.toJSON()).toContain(mark);
    }
  });

  it('gives what the page holds even when the session takes no more changes', () => {
    const refusing = new VisualBinding(
      { text, edit: () => {}, onBeforeRemote: () => () => {}, active: () => false },
      editor,
    );
    editor.shown = 'One.\n\nTwo!\n';
    expect(refusing.write()).toBe('One.\n\nTwo!\n');
    expect(text.toJSON()).toBe('One.\n\nTwo.\n');
    refusing.destroy();
  });
});
