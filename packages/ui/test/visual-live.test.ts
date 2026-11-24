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
import { REPAIR_MS, readsCleanly } from '../src/page/editor/visual/live-repair.ts';
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
    // By character, the "r" both have was kept, and it was taken out: as two
    // people changing one word at once can leave it, for either to fix.
    expect(applyTo(body, carried)).toBe('hello thee\n');
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

  it('changes each of two places a character apart, leaving what someone did between', () => {
    const held = 'x a-b y\n';
    const body = 'x ab y\n';
    const next = 'x A-B y\n';
    expect(ownChanges(held, next)).toHaveLength(2);
    const carried = Mapping.between(held, body).carry(ownChanges(held, next));
    expect(applyTo(body, carried)).toBe('x AB y\n');
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
    // The text checked went in, the person's typing carried onto it.
    expect(editor.wholes).toHaveLength(1);
    expect(editor.wholes[0]).toContain('```\n');
    expect(editor.wholes[0]).toContain('Two2');
    // Once others pause, it catches up.
    await vi.advanceTimersByTimeAsync(WHOLE_MS * 3);
    await settle();
    expect(editor.shown).toBe(text.toJSON());
  });

  it('keeps following exactly through a whole read others and the person typed through', async () => {
    editor.byBlock = false;
    editor.checkMs = 300;
    theirs('sam', (body) => body.insert(0, '```\n'));
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(150);
      theirs('sam', (body) => body.insert(body.length, String(i)));
      if (i === 2) {
        editor.shown = editor.shown.replace('Two.', 'the dog.');
        binding.write();
        theirs('rita', (body) => body.insert(body.toJSON().indexOf('the dog'), 'the cat '));
      }
      await vi.advanceTimersByTimeAsync(150);
      await settle();
    }
    expect(editor.wholes).toHaveLength(1);
    // The person deletes "the " of their "the dog" before Rita's comes in.
    editor.shown = editor.shown.replace('the dog', 'dog');
    binding.write();
    expect(text.toJSON()).toContain('the cat dog.');
  });

  it('catches up at once when there’s too much to follow', async () => {
    text.delete(0, text.length);
    text.insert(0, '- bar\n' + 'y'.repeat(3_000));
    editor.shown = text.toJSON();
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    theirs('rita', (body) => body.insert(0, '- foo\n'));
    // Mallory changes nothing anyone sees, in more places than are followed.
    theirs('mallory', (body) => {
      for (let i = 0; i < 1_100; i++) {
        const at = 12 + i * 2;
        body.delete(at, 1);
        body.insert(at, 'y');
      }
    });
    // Taken in at once, not a tenth of a second on.
    await vi.advanceTimersByTimeAsync(1);
    expect(editor.shown).toBe(text.toJSON());
    expect(editor.shown.startsWith('- foo\n- bar')).toBe(true);
    editor.shown = editor.shown.replace('- bar', 'bar');
    binding.write();
    expect(text.toJSON().startsWith('- foo\nbar')).toBe(true);
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

describe('two people formatting the same text at once (#720)', () => {
  type Side = { doc: Y.Doc; editor: FakeEditor; binding: VisualBinding; before: Set<() => void> };
  let sides: Side[] = [];

  const side = (doc: Y.Doc): Side => {
    const text = doc.getText('body');
    const before = new Set<() => void>();
    const editor = new FakeEditor(text.toJSON());
    const binding = new VisualBinding(
      {
        text,
        edit: (change) => doc.transact(change),
        onBeforeRemote: (listener) => {
          const heard = () => listener('them');
          before.add(heard);
          return () => void before.delete(heard);
        },
        active: () => true,
      },
      editor,
    );
    return { doc, editor, binding, before };
  };
  // What `to` hasn't of `from`'s, as the participant applies it.
  const send = (from: { doc: Y.Doc }, to: Side | { doc: Y.Doc }) => {
    const update = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc));
    if ('before' in to) for (const listener of to.before) listener();
    Y.applyUpdate(to.doc, update, 'remote');
  };
  // Everyone's changes to everyone, until nobody changes anything more.
  const exchange = async (docs: { doc: Y.Doc }[] = sides) => {
    for (let i = 0; i < 4; i++) {
      for (const from of docs) for (const to of docs) if (from !== to) send(from, to);
      await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    }
  };
  const bodyOf = (s: { doc: Y.Doc }) => s.doc.getText('body').toJSON();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    for (const s of sides.splice(0)) s.binding.destroy();
    vi.useRealTimers();
  });

  // A doc with `page`, Yjs client `client`.
  const docOf = (page: string, client: number, from?: Y.Doc) => {
    const doc = new Y.Doc();
    doc.clientID = client;
    if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
    else doc.getText('body').insert(0, page);
    return doc;
  };
  // Two people with `page`, A's Yjs client lower than B's, or higher.
  const start = (page: string, aLower: boolean) => {
    for (const s of sides.splice(0)) s.binding.destroy();
    const a = docOf(page, aLower ? 1_000 : 2_000);
    const b = docOf(page, aLower ? 2_000 : 1_000, a);
    sides = [side(a), side(b)];
    return sides as [Side, Side];
  };
  const orders = [true, false];
  // A and B each write their text of `was` at once, then hear each other's.
  const merged = async (was: string, mine: string, theirs: string, aLower: boolean) => {
    const [a, b] = start(was, aLower);
    a.editor.shown = mine;
    b.editor.shown = theirs;
    a.binding.write();
    b.binding.write();
    await exchange();
    expect(bodyOf(b)).toBe(bodyOf(a));
    expect(a.editor.shown).toBe(bodyOf(a));
    expect(b.editor.shown).toBe(bodyOf(b));
    return bodyOf(a);
  };

  // A's and B's writing of `was`, merged by character as Yjs merges them, with no repair.
  const byCharacter = (was: string, mine: string, theirs: string, aLower: boolean) => {
    const a = docOf(was, aLower ? 1_000 : 2_000);
    const b = docOf(was, aLower ? 2_000 : 1_000, a);
    putInto(a.getText('body'), ownChanges(was, mine));
    putInto(b.getText('body'), ownChanges(was, theirs));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    return a.getText('body').toJSON();
  };

  const red = (tag: string, inner: string, color = 'red') =>
    `<${tag} data-color="${color}">${inner}</${tag}>`;
  const hi = (inner: string) => red('mark', inner);
  const line = (run: string) => `Hello ${run} there.\n\nNext.\n`;

  // Each merges correctly by character, as it did before repairs: exactly so, either way round.
  it.each([
    ['a capital', line('world'), line(hi('world')), line('World'), line(hi('World'))],
    ['a typo fixed', line('wrold'), line(hi('wrold')), line('world'), line(hi('world'))],
    [
      'typing inside',
      line('world'),
      line(hi('world')),
      line('wonderworld'),
      line(hi('wonderworld')),
    ],
    ['a letter deleted', line('world'), line(hi('world')), line('word'), line(hi('word'))],
    [
      'the stop after it deleted',
      'Hello world. there\n',
      `Hello ${hi('world')}. there\n`,
      'Hello world there\n',
      `Hello ${hi('world')} there\n`,
    ],
    [
      'bold taken off',
      'Say **world** now.\n',
      `Say **${hi('world')}** now.\n`,
      'Say world now.\n',
      `Say ${hi('world')} now.\n`,
    ],
    [
      'a link’s address changed',
      line('[world](https://old.test)'),
      line(hi('[world](https://old.test)')),
      line('[world](https://new.test)'),
      line(hi('[world](https://new.test)')),
    ],
    [
      'two letters of a word',
      line('world'),
      line(`${hi('w')}orld`),
      line(`worl${red('span', 'd')}`),
      line(`${hi('w')}orl${red('span', 'd')}`),
    ],
    [
      'two words with a comma between',
      'Hello,world there.\n',
      `${hi('Hello')},world there.\n`,
      `Hello,${red('span', 'world')} there.\n`,
      `${hi('Hello')},${red('span', 'world')} there.\n`,
    ],
    ['a highlight taken off twice', line(hi('world')), line('world'), line('world'), line('world')],
    [
      'a part of what’s highlighted coloured',
      'Completion: (50%).\n',
      `Completion: ${hi('(50%)')}.\n`,
      `Completion: (${red('span', '50')}%).\n`,
      `Completion: ${hi(`(${red('span', '50')}%)`)}.\n`,
    ],
    [
      'a word typed after it',
      line('world'),
      line(hi('world')),
      line('world big'),
      line(`${hi('world')} big`),
    ],
  ])('merges a highlight with %s as by character', async (_, was, mine, theirs, both) => {
    for (const aLower of orders) {
      expect(byCharacter(was, mine, theirs, aLower)).toBe(both);
      expect(await merged(was, mine, theirs, aLower)).toBe(both);
    }
  });

  // Each merges by character into HTML neither wrote: the higher client's writing stands.
  it.each([
    ['**==world==**', red('mark', '**world**'), red('span', '==**world**==')],
    ['**world**', red('mark', '**world**'), red('span', '**world**')],
    ['**world**', '==**world**==', red('span', '**world**')],
    ['==**world**==', red('mark', '**world**'), red('span', '==**world**==')],
    ['world', hi('world'), '**world**'],
    ['world', hi('world'), '[world](https://x.test)'],
    ['world', hi('world'), hi('world')],
    [hi('world'), red('mark', 'world', 'blue'), red('mark', 'world', 'green')],
    ['big world', `${hi('big wo')}rld`, `big w${hi('orld')}`],
    ['world', hi('world'), red('span', 'world')],
  ])(
    'from %s, settles to one side’s writing, never HTML neither wrote',
    async (was, mine, theirs) => {
      for (const aLower of orders)
        expect(await merged(line(was), line(mine), line(theirs), aLower)).toBe(
          aLower ? line(theirs) : line(mine),
        );
    },
  );

  it('settles to the writing of one who put text in, against one who only took it out', async () => {
    // Taking text out leaves nothing of the app's own in the block: Yjs
    // doesn't say whose a deletion was, so only the other can be the one.
    const [was, mine, theirs] = [line(hi('world')), line('world'), line(red('span', hi('world')))];
    for (const aLower of orders) expect(await merged(was, mine, theirs, aLower)).toBe(theirs);
  });

  it('keeps what the other typed farther off in the block, and only that', async () => {
    const was = 'Hello **world** there.\nAnd more.\n';
    const mine = `Hello ${red('mark', '**world**')} there.\nAnd more.\n`;
    // Typed on the next line and just before the word, with the colour.
    const theirs = `Hello big ${red('span', '**world**')} there.\nAnd more again.\n`;
    // B's writing stands, all of it.
    expect(await merged(was, mine, theirs, true)).toBe(theirs);
    // A's stands, with B's typing on the next line; "big " beside A's highlight goes with B's colour.
    expect(await merged(was, mine, theirs, false)).toBe(
      `Hello ${red('mark', '**world**')} there.\nAnd more again.\n`,
    );
  });

  it('leaves other blocks, and a third person who changed none of it', async () => {
    const page = `Hello **world** there.\n\nOther.\n`;
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = side(docOf(page, 1_500, a.doc));
      sides.push(c);
      a.editor.shown = `Hello ${red('mark', '**world**')} there.\n\nOther.\n`;
      b.editor.shown = `Hello ${red('span', '**world**')} there.\n\nOther.\n`;
      c.editor.shown = `Hello **world** there.\n\nOther, said C.\n`;
      for (const s of sides) s.binding.write();
      await exchange();
      const higher = aLower ? 'span' : 'mark';
      for (const s of sides)
        expect(bodyOf(s)).toBe(`Hello ${red(higher, '**world**')} there.\n\nOther, said C.\n`);
    }
  });

  it('settles formatting that came after the other’s typing reached it', async () => {
    // B types elsewhere first, which A takes in, then formats as A did.
    const [a, b] = start(line('**world**'), false);
    a.editor.shown = line(red('mark', '**world**'));
    a.binding.write();
    b.editor.shown = line('**world**').replace('Next.', 'Next!');
    b.binding.write();
    send(b, a);
    await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    b.editor.shown = line(red('span', '**world**')).replace('Next.', 'Next!');
    b.binding.write();
    await exchange();
    expect(bodyOf(a)).toBe(line(red('mark', '**world**')).replace('Next.', 'Next!'));
    expect(bodyOf(b)).toBe(bodyOf(a));
  });

  it.each([
    ['at the line’s start', 0],
    ['beside the highlight', 'Hello '.length],
    ['after the highlight', `Hello ${hi('world')}`.length],
    ['inside the highlighted word', 'Hello <mark data-color="red">wo'.length],
  ])(
    'never undoes colour HTML someone types or pastes by hand %s in a block it formatted',
    async (_, at) => {
      const typed = '<span data-color="red">';
      for (const paste of [false, true]) {
        const [a] = start(line('world'), false);
        sides.splice(1).forEach((s) => s.binding.destroy());
        // C edits the source, with no binding, from a lower client than A's,
        // having seen A's highlight a while: past the time two changes can be at once.
        const c = { doc: docOf('', 500, a.doc) };
        a.editor.shown = line(hi('world'));
        a.binding.write();
        await exchange([a, c]);
        await vi.advanceTimersByTimeAsync(REPAIR_MS);
        const expected = (n: number) => {
          const page = line(hi('world'));
          return page.slice(0, at) + typed.slice(0, n) + page.slice(at);
        };
        if (paste) {
          c.doc.getText('body').insert(at, typed);
          await exchange([a, c]);
          expect(bodyOf(a)).toBe(expected(typed.length));
          continue;
        }
        for (let i = 1; i <= typed.length; i++) {
          c.doc.getText('body').insert(at + i - 1, typed[i - 1] as string);
          await exchange([a, c]);
          expect(bodyOf(a)).toBe(expected(i));
        }
      }
    },
  );

  it('never puts back a tag someone deleted knowing it was there', async () => {
    const [a] = start(line('world'), false);
    sides.splice(1).forEach((s) => s.binding.destroy());
    const c = { doc: docOf('', 500, a.doc) };
    a.editor.shown = line(hi('world'));
    a.binding.write();
    // C has A's highlight, and takes its end out, before A takes anything in.
    send(a, c);
    const body = c.doc.getText('body');
    body.delete(body.toJSON().indexOf('</mark>'), '</mark>'.length);
    await exchange([a, c]);
    expect(bodyOf(a)).toBe(line('<mark data-color="red">world'));
  });

  it('never undoes what the person types in split view’s source pane', async () => {
    const [a] = start(line('world'), false);
    sides.splice(1).forEach((s) => s.binding.destroy());
    const c = { doc: docOf('', 500, a.doc) };
    a.editor.shown = line(hi('world'));
    a.binding.write();
    await exchange([a, c]);
    // The same app's Yjs client, as the source pane writes, at once after.
    const body = a.doc.getText('body');
    for (const [i, char] of Array.from('<span class="x">').entries()) {
      body.insert(i, char);
      await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    }
    expect(bodyOf(a)).toBe(`<span class="x">${line(hi('world'))}`);
  });

  it('keeps others’ changes main keeps, as text naming a colour or HTML in code', async () => {
    for (const [was, mine, theirs] of [
      // Typed in the word someone highlights.
      [line('world'), line(hi('world')), line('wdata-colororld')],
      // A link's address changed as someone highlights it.
      [
        line('[world](https://old.test)'),
        line(hi('[world](https://old.test)')),
        line('[world](https://new.test/?data-color=red)'),
      ],
      // Code in a fence with blank lines in it.
      ['```html\n\nXYZ\n\n```\n', '```html\n\nX!YZ\n\n```\n', '```html\n\nX</mark>YZ\n\n```\n'],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('settles a word someone highlights as someone else types beside it, to one side', async () => {
    for (const word of ['card', 'colour', 'ok', 'tea']) {
      for (const aLower of orders) {
        const [mine, theirs] = [line(hi(word)), line(`big ${word}`)];
        const result = await merged(line(word), mine, theirs, aLower);
        // Main splices the typing into the tag (`<mark data-big color="red">card`).
        expect([mine, theirs, line(`big ${hi(word)}`)]).toContain(result);
      }
    }
    for (const aLower of orders) {
      const [mine, theirs] = [line(red('span', '==world==')), line('big ==world==')];
      expect([mine, theirs, line(`big ${red('span', '==world==')}`)]).toContain(
        await merged(line('==world=='), mine, theirs, aLower),
      );
    }
  });

  it('leaves the same plain highlight put on twice as by character, Markdown, not HTML', async () => {
    for (const aLower of orders)
      expect(await merged(line('world'), line('==world=='), line('==world=='), aLower)).toBe(
        byCharacter(line('world'), line('==world=='), line('==world=='), aLower),
      );
  });

  it('repairs what it wrote though it typed more there before taking the other’s in', async () => {
    const [a, b] = start(line('world'), false);
    a.editor.shown = line(hi('world'));
    b.editor.shown = line(red('span', 'world'));
    a.binding.write();
    b.binding.write();
    send(b, a);
    // A types on the line as B's change comes in, before taking it in.
    a.editor.shown = line(hi('world')).replace('there.', 'there!');
    a.binding.write();
    await exchange();
    expect(bodyOf(a)).toBe(line(hi('world')).replace('there.', 'there!'));
    expect(bodyOf(b)).toBe(bodyOf(a));
  });

  it('keeps a third person’s typing on another line of the block', async () => {
    const page = 'Hello world there.\nSaid C.\n';
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = side(docOf(page, 3_000, a.doc));
      sides.push(c);
      a.editor.shown = page.replace('world', hi('world'));
      b.editor.shown = page.replace('world', red('span', 'world'));
      c.editor.shown = page.replace('Said C.', 'Said C, typing.');
      for (const s of sides) s.binding.write();
      await exchange();
      const higher = aLower ? red('span', 'world') : hi('world');
      for (const s of sides)
        expect(bodyOf(s)).toBe(page.replace('world', higher).replace('Said C.', 'Said C, typing.'));
    }
  });

  it('keeps others’ text main keeps: `=` runs, code in a fence, a new paragraph', async () => {
    for (const [was, mine, theirs] of [
      // A change elsewhere on the line, and three `=` typed as text.
      [line('world'), line('world').replace('Hello', 'Hi'), line('world x===y')],
      [line('world'), line('world').replace('Hello', 'Hi'), line('world ![notes===v2===.png](u)')],
      // Code under a line that starts with three backticks but doesn't close the fence.
      [
        '```\nfirst\n```not a closing fence\n\nXYZ\n\n```\n',
        '```\nfirst\n```not a closing fence\n\nX!YZ\n\n```\n',
        '```\nfirst\n```not a closing fence\n\nXY</mark>Z\n\n```\n',
      ],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('settles crossed tags below a fence that ended with its quote', async () => {
    const above = '> ```\n> code\n\n';
    for (const aLower of orders)
      expect(
        await merged(
          `${above}${line('world')}`,
          `${above}${line(hi('world'))}`,
          `${above}${line(red('span', 'world'))}`,
          aLower,
        ),
      ).toBe(`${above}${line(aLower ? red('span', 'world') : hi('world'))}`);
  });

  it('keeps a paragraph the other added after the line it repairs', async () => {
    const was = 'Hello world there.';
    for (const aLower of orders) {
      const mine = `Hello ${hi('world')} there.`;
      const theirs = `Hello ${red('span', 'world')} there.\n\nNew paragraph!`;
      const result = await merged(was, mine, theirs, aLower);
      expect(result).toBe(aLower ? theirs : `${mine}\n\nNew paragraph!`);
    }
  });

  it('never puts back what the person deleted in split view’s source pane', async () => {
    const [a, b] = start(line('world'), false);
    a.editor.shown = line(hi('world'));
    b.editor.shown = line(red('span', 'world'));
    a.binding.write();
    b.binding.write();
    // A's own app deletes " there." from the source pane before B's change comes.
    const body = a.doc.getText('body');
    body.delete(body.toJSON().indexOf(' there.'), ' there.'.length);
    await exchange();
    expect(bodyOf(a)).toContain('Hello');
    expect(bodyOf(a)).not.toContain('there.');
    expect(bodyOf(b)).toBe(bodyOf(a));
  });

  it('repairs once when one took a highlight off after typing the other had', async () => {
    for (const aLower of orders) {
      const [a, b] = start(line(hi('world')), aLower);
      // A types elsewhere on the line, which B takes in.
      a.editor.shown = line(hi('world')).replace('Hello', 'Hello!');
      a.binding.write();
      await exchange();
      // Then, at once, A takes the highlight off and B colours the word.
      a.editor.shown = line('world').replace('Hello', 'Hello!');
      b.editor.shown = line(red('span', hi('world'))).replace('Hello', 'Hello!');
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(b.editor.shown);
      expect(bodyOf(b)).toBe(bodyOf(a));
    }
  });

  it('settles with a third person typing farther along the same line, keeping it', async () => {
    const page = 'Hello world there.\n';
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = side(docOf(page, 3_000, a.doc));
      sides.push(c);
      a.editor.shown = page.replace('world', hi('world'));
      b.editor.shown = page.replace('world', red('span', 'world'));
      c.editor.shown = page.replace('there.', 'there. New text.');
      for (const s of sides) s.binding.write();
      await exchange();
      const higher = aLower ? red('span', 'world') : hi('world');
      for (const s of sides) expect(bodyOf(s)).toBe(`Hello ${higher} there. New text.\n`);
    }
  });

  it('reads markers above a conflict in time that grows with their number, not faster', async () => {
    for (const marker of ['* ', '-  ', '> ', '1. ', '- - ']) {
      const above = `${marker.repeat(40)}x\n\n`;
      const started = Date.now();
      await merged(
        `${above}${line('world')}`,
        `${above}${line(hi('world'))}`,
        `${above}${line(red('span', 'world'))}`,
        false,
      );
      expect(Date.now() - started, marker).toBeLessThan(1_000);
    }
  });

  it('repairs many lines of one block in time that grows with their number, not faster', async () => {
    const lines = (n: number, run: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => `Line ${i} ${run(i)} end.`).join('\n') + '\n';
    // Past about 40 lines the editor's change goes in as the whole block, which merges cleanly.
    const time = async (n: number) => {
      const real = Date.now();
      const result = await merged(
        lines(n, () => 'world'),
        lines(n, () => hi('world')),
        lines(n, () => red('span', 'world')),
        false,
      );
      expect(result).toBe(lines(n, () => hi('world')));
      return Date.now() - real;
    };
    const short = await time(5);
    const result = await time(40);
    expect(result).toBeLessThan(24 * Math.max(short, 5));
  });

  it('keeps `=` runs and code main keeps', async () => {
    for (const [was, mine, theirs] of [
      ['Checksum xy.\n', 'Checksum x===y.\n', 'Checksum x=y.\n'],
      [line('world'), line(hi('world')), line('world x====y')],
      // A list item's fence line inside a fence on the page is code.
      [
        '```\n- ```\n\nHello world there.\n```\n',
        '```\n- ```\n\nHello <mark>world</mark> there.\n```\n',
        '```\n- ```\n\nHello <span>world</span> there.\n```\n',
      ],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('settles crossed tags in a quote after a quote whose fence it ended', async () => {
    const above = '> ```\n> code\n\n> ';
    for (const aLower of orders)
      expect(
        await merged(
          `${above}${line('world')}`,
          `${above}${line(hi('world'))}`,
          `${above}${line(red('span', 'world'))}`,
          aLower,
        ),
      ).toBe(`${above}${line(aLower ? red('span', 'world') : hi('world'))}`);
  });

  it('leaves a colour changed as the other takes the highlight off as main does: text, not HTML', async () => {
    for (const color of ['blue', 'green', 'purple'])
      for (const aLower of orders) {
        const mine = line(red('mark', 'world', color));
        expect(await merged(line(hi('world')), mine, line('world'), aLower)).toBe(
          byCharacter(line(hi('world')), mine, line('world'), aLower),
        );
      }
  });

  it('keeps what a third person changes on the line, without the binding or with it', async () => {
    const page = 'Hello world and the cat.\n';
    for (const aLower of orders)
      for (const [client, change, from, to] of [
        [500, (t: Y.Text) => t.delete(t.toJSON().indexOf(' and'), ' and'.length), ' and', ''],
        [3_000, (t: Y.Text) => t.delete(t.toJSON().indexOf(' and'), ' and'.length), ' and', ''],
        [500, (t: Y.Text) => t.insert(t.toJSON().indexOf('.'), '!'), '.', '!.'],
      ] as const) {
        const [a, b] = start(page, aLower);
        const c = { doc: docOf('', client, a.doc) };
        a.editor.shown = page.replace('world', hi('world'));
        b.editor.shown = page.replace('world', red('span', 'world'));
        a.binding.write();
        b.binding.write();
        change(c.doc.getText('body'));
        await exchange([a, b, c]);
        const expected = page
          .replace('world', aLower ? red('span', 'world') : hi('world'))
          .replace(from, to);
        for (const s of [a, b, c]) expect(bodyOf(s)).toBe(expected);
      }
  });

  it('keeps a third person’s word replaced on the line, and typing beside the tags', async () => {
    for (const [page, theirs] of [
      ['Hello world and the cat.\n', 'Hello world and the dog.\n'],
      ['Hello world there.\n', 'Hello big world there.\n'],
    ] as const)
      for (const aLower of orders) {
        const [a, b] = start(page, aLower);
        const c = side(docOf(page, 3_000, a.doc));
        sides.push(c);
        a.editor.shown = page.replace('world', hi('world'));
        b.editor.shown = page.replace('world', red('span', 'world'));
        c.editor.shown = theirs;
        for (const s of sides) s.binding.write();
        await exchange();
        const higher = aLower ? red('span', 'world') : hi('world');
        const typed = theirs.replace('world', higher);
        // Yjs may put the third's typing beside the tag, inside it or out.
        const inside = typed.replace(`big ${higher}`, higher.replace('>world', '>big world'));
        for (const s of sides) expect([typed, inside]).toContain(bodyOf(s));
        expect(bodyOf(b)).toBe(bodyOf(a));
      }
  });

  it('never undoes a deletion made in the source pane while a take-in was under way', async () => {
    class Slow extends FakeEditor {
      override take(text: string) {
        return new Promise<true>((resolve) =>
          setTimeout(() => {
            this.shown = text;
            resolve(true);
          }, 50),
        );
      }
    }
    const page = `${line('world')}\nNext.\n`;
    const a = docOf(page, 2_000);
    const b = docOf(page, 1_000, a);
    const text = a.getText('body');
    const before = new Set<() => void>();
    const editor = new Slow(page);
    const binding = new VisualBinding(
      {
        text,
        edit: (change) => a.transact(change),
        onBeforeRemote: (listener) => {
          const heard = () => listener('them');
          before.add(heard);
          return () => void before.delete(heard);
        },
        active: () => true,
      },
      editor,
    );
    const sideA = { doc: a, editor, binding, before } as unknown as Side;
    const sideB = side(b);
    sides.push(sideA, sideB);
    editor.shown = page.replace('world', hi('world'));
    binding.write();
    // B changes the next paragraph; A starts taking it in.
    b.getText('body').insert(b.getText('body').toJSON().indexOf('Next'), 'The ');
    send(sideB, sideA);
    await vi.advanceTimersByTimeAsync(TAKE_MS + 10);
    // Meanwhile A deletes " there." in the source pane, and B colours the word.
    text.delete(text.toJSON().indexOf(' there.'), ' there.'.length);
    sideB.editor.shown = page.replace('world', red('span', 'world')).replace('Next', 'The Next');
    sideB.binding.write();
    await exchange([sideA, sideB]);
    expect(bodyOf(sideA)).not.toContain('there.');
    expect(bodyOf(sideB)).toBe(bodyOf(sideA));
  });

  it('keeps tag text in maths and code as main does', async () => {
    for (const [was, mine, theirs] of [
      [line('$world$'), line(`$${hi('world')}$`), line(`$${red('span', 'world')}$`)],
      [
        '$$\nworld\n\nmore\n$$\n',
        `$$\n${hi('world')}\n\nmore\n$$\n`,
        `$$\n${red('span', 'world')}\n\nmore\n$$\n`,
      ],
      ['Use `<pan>` here.\n', 'Use `<span>` here.\n', 'Use `pan>` here.\n'],
      ['Use `<pan>` here.\n', 'Use `<span>` here.\n', 'Use ahere.\n'],
      ['    <spn>\n', '    <span>\n', '    spn>\n'],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('settles code put on a word someone highlights', async () => {
    for (const aLower of orders) {
      const [mine, theirs] = [line(hi('world')), line('`world`')];
      expect([mine, theirs, line(hi('`world`'))]).toContain(
        await merged(line('world'), mine, theirs, aLower),
      );
    }
  });

  it('puts back only the tag text taken out, not a word someone deleted', async () => {
    // B takes the highlight off as A colours the word, and C deletes the first word.
    const page = `Hello ${hi('world')} there.\n`;
    const colour = red('span', hi('world'));
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = { doc: docOf('', 500, a.doc) };
      a.editor.shown = page.replace(hi('world'), colour);
      b.editor.shown = page.replace(hi('world'), 'world');
      a.binding.write();
      b.binding.write();
      c.doc.getText('body').delete(0, 'Hello '.length);
      await exchange([a, b, c]);
      for (const s of [a, b, c]) expect(bodyOf(s)).toBe(`${colour} there.\n`);
    }
  });

  it('leaves alone a source edit to another tag on the line', async () => {
    const page = `${hi('Hi')} world there.\n`;
    for (const aLower of orders) {
      const [a] = start(page, !aLower);
      sides.splice(1).forEach((s) => s.binding.destroy());
      const c = { doc: docOf('', aLower ? 500 : 5_000, a.doc) };
      a.editor.shown = page.replace(' world', ` ${hi('world')}`);
      a.binding.write();
      await exchange([a, c]);
      // C, by hand, recolours Hi a key at a time.
      const body = c.doc.getText('body');
      const at = body.toJSON().indexOf('red');
      body.delete(at, 3);
      await exchange([a, c]);
      for (const [i, char] of Array.from('blue').entries()) {
        body.insert(at + i, char);
        await exchange([a, c]);
      }
      expect(bodyOf(a)).toBe(a.editor.shown.replace('"red">Hi', '"blue">Hi'));
    }
  });

  it('leaves the colour’s letters as main does when the other typed on the line too', async () => {
    const was = line(hi('world'));
    const mine = line(red('mark', 'world', 'blue'));
    for (const theirs of ['Goodbye all.\n\nNext.\n', line('earth')])
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
    // Two highlights side by side, each recoloured by one and taken off by the other.
    const pair = `Hello ${hi('world')}${red('mark', 'there', 'green')}.\n`;
    const one = `Hello ${red('mark', 'world', 'blue')}there.\n`;
    const other = `Hello world${red('mark', 'there', 'purple')}.\n`;
    for (const aLower of orders)
      expect(await merged(pair, one, other, aLower)).toBe(byCharacter(pair, one, other, aLower));
  });

  it('repairs after the person typed and took back a character in the source pane', async () => {
    for (const aLower of orders) {
      const [a, b] = start(line('world'), aLower);
      const body = a.doc.getText('body');
      body.insert(5, '!');
      body.delete(5, 1);
      await exchange();
      a.editor.shown = line(hi('world'));
      b.editor.shown = line(red('span', 'world'));
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(aLower ? line(red('span', 'world')) : line(hi('world')));
      expect(bodyOf(b)).toBe(bodyOf(a));
    }
  });

  it('keeps a source edit main keeps: a link’s address in angle brackets', async () => {
    const was = 'Hello [click](old) and world.\n';
    for (const aLower of orders)
      for (const [mine, theirs] of [
        [was.replace('world', hi('world')), was.replace('(old)', '(<mark>)')],
        [was.replace('(old)', '(<mark>)'), was.replace('world', hi('world'))],
      ] as const)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('keeps a third person’s typing beside another, sound highlight on the line', async () => {
    const page = `Hello world and ${red('mark', 'there')}.\n`;
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = { doc: docOf('', 500, a.doc) };
      a.editor.shown = page.replace('world', hi('world'));
      b.editor.shown = page.replace('world', red('span', 'world'));
      a.binding.write();
      b.binding.write();
      const body = c.doc.getText('body');
      body.insert(body.toJSON().indexOf('<mark'), 'score=');
      await exchange([a, b, c]);
      const higher = aLower ? red('span', 'world') : hi('world');
      const expected = page.replace(' <mark', ' score=<mark').replace('world', higher);
      for (const s of [a, b, c]) expect(bodyOf(s)).toBe(expected);
    }
  });

  it('keeps what main keeps: typing beside the tags, link addresses, nested colours, code', async () => {
    const twain = 'See my [notes](old.md) here.\n';
    for (const [was, mine, theirs] of [
      // A link's address in angle brackets, typed into from both sides.
      ['[click](<mk notes.md>)\n', '[click](<mrk notes.md>)\n', '[click](<mak notes.md>)\n'],
      [
        twain,
        twain.replace('my [notes](old.md)', hi('my [notes](old.md)')),
        twain.replace('(old.md)', '(<Mark Twain.md>)'),
      ],
      // A colour inside a highlight of another colour.
      [
        line('big world today'),
        line(hi('big world today')),
        line(`big ${red('mark', 'world', 'blue')} today`),
      ],
      // Code under a space and a tab.
      [' \tworld\n', ` \t${hi('world')}\n`, ` \t${red('span', 'world')}\n`],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('keeps a third person’s typing that only meets the tags', async () => {
    for (const aLower of orders) {
      const [a, b] = start(line('world'), aLower);
      const c = { doc: docOf('', 500, a.doc) };
      a.editor.shown = line(hi('world'));
      b.editor.shown = line(red('span', 'world'));
      a.binding.write();
      b.binding.write();
      c.doc.getText('body').insert('Hello '.length, 'score=');
      await exchange([a, b, c]);
      const higher = aLower ? red('span', 'world') : hi('world');
      for (const s of [a, b, c]) expect(bodyOf(s)).toBe(line(`score=${higher}`));
    }
  });

  it('leaves a source recolour of a highlight across lines, and settles the word', async () => {
    const page = `Hello ${hi('some\ntext')} and world there.\n`;
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = { doc: docOf('', 500, a.doc) };
      a.editor.shown = page.replace('world', hi('world'));
      b.editor.shown = page.replace('world', red('span', 'world'));
      a.binding.write();
      b.binding.write();
      const body = c.doc.getText('body');
      const at = body.toJSON().indexOf('red');
      body.delete(at, 3);
      body.insert(at, 'blue');
      await exchange([a, b, c]);
      const higher = aLower ? red('span', 'world') : hi('world');
      const expected = page.replace('"red"', '"blue"').replace('world', higher);
      for (const s of [a, b, c]) expect(bodyOf(s)).toBe(expected);
    }
  });

  it('settles crossed tags in a list item after its fence', async () => {
    const above = '- ```\n  literal\n  ```\n\n  ';
    for (const aLower of orders)
      expect(
        await merged(
          `${above}${line('world')}`,
          `${above}${line(hi('world'))}`,
          `${above}${line(red('span', 'world'))}`,
          aLower,
        ),
      ).toBe(`${above}${line(aLower ? red('span', 'world') : hi('world'))}`);
  });

  it('repairs once when the other formatted before its editor took this one in', async () => {
    const [a, b] = start('abcdefgh\n', false);
    a.editor.shown = `${hi('abcdef')}gh\n`;
    a.binding.write();
    // B has A's highlight in Yjs, but its editor colours what it showed before.
    send(a, b);
    b.editor.shown = `abc${red('span', 'defgh')}\n`;
    b.binding.write();
    send(b, a);
    await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    await exchange();
    expect(bodyOf(b)).toBe(bodyOf(a));
    expect([`${hi('abcdef')}gh\n`, `abc${red('span', 'defgh')}\n`]).toContain(bodyOf(a));
  });

  it('never puts back tags someone takes out by hand away from what it wrote', async () => {
    const page = `${hi('Hi')} world there and more.\n`;
    for (const aLower of orders) {
      const [a] = start(page, !aLower);
      sides.splice(1).forEach((s) => s.binding.destroy());
      const c = { doc: docOf('', aLower ? 500 : 5_000, a.doc) };
      a.editor.shown = page.replace('more', hi('more'));
      a.binding.write();
      await exchange([a, c]);
      // C backspaces Hi's end tag, then its start tag, a key at a time.
      const body = c.doc.getText('body');
      const open = '<mark data-color="red">'.length;
      for (const [from, length] of [
        [open + 'Hi'.length, '</mark>'.length],
        [0, open],
      ] as const)
        for (let i = length - 1; i >= 0; i--) {
          body.delete(from + i, 1);
          await exchange([a, c]);
        }
      expect(bodyOf(a)).toBe(`Hi world there and ${hi('more')}.\n`);
    }
  });

  it('leaves a block broken when the one to repair it is gone', async () => {
    const [a, b] = start(line('world'), true);
    a.editor.shown = line(hi('world'));
    b.editor.shown = line(red('span', 'world'));
    a.binding.write();
    b.binding.write();
    // B, the higher client, leaves before A's change reaches it.
    b.binding.destroy();
    await exchange([a, b]);
    expect(bodyOf(a)).toBe(
      line('<mark data-color="red"><span data-color="red">world</mark></span>'),
    );
  });

  it('leaves a merge of two docs with no binding as Yjs makes it', () => {
    // As the issue's test does it: the merge itself is as it was.
    const was = line('**world**');
    const a = docOf(was, 1_000);
    const b = docOf(was, 2_000, a);
    putInto(a.getText('body'), ownChanges(was, line(red('mark', '**world**'))));
    putInto(b.getText('body'), ownChanges(was, line(red('span', '**world**'))));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(a.getText('body').toJSON()).toBe(
      line('<mark data-color="red"><span data-color="red">**world**</mark></span>'),
    );
  });

  it('takes in plain typing on a long page as quickly as before', async () => {
    const paragraph = (i: number) => `Para ${i} has ${hi('colour')} and **bold** text.`;
    const page = Array.from({ length: 3_000 }, (_, i) => paragraph(i)).join('\n\n') + '\n';
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      // A formatted a word in the middle, which B has.
      a.editor.shown = page.replace('Para 1500 has', `Para 1500 ${red('span', 'has')}`);
      a.binding.write();
      await exchange();
      const started = Date.now();
      for (let i = 0; i < 20; i++) {
        b.editor.shown = b.editor.shown.replace('Para 1500', 'Para 1500x');
        b.binding.write();
        send(b, a);
        await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
      }
      process.stderr.write(`long page: ${Date.now() - started} ms\n`);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(bodyOf(a)).toBe(bodyOf(b));
    }
  });
});

describe('whether a block reads cleanly', () => {
  it('tells tags crossed, unbalanced, misspelt or one inside its own kind', () => {
    for (const broken of [
      '<mark data-color="red"><span data-color="red">world</mark></span>',
      '<mark data-color="red">world',
      'world</span>',
      '<span data-color"red">world</span>',
      '<mark data-color="gblueen">world</mark>',
      '<mark data-color="red"><mark data-color="red">world</mark></mark>',
      '<mark data-color="red">**world</mark>**',
      '<mark data-color="red">[world</mark>](https://x.test)',
      'span data-color="red"><world</span>',
    ])
      expect(readsCleanly(`Hello ${broken} there.`), broken).toBe(false);
  });

  it('reads as clean colours nested, beside marks, and tags in code', () => {
    for (const clean of [
      'Hello there.',
      '<mark data-color="red">world</mark>',
      '<span data-color="red"><mark data-color="red">world</mark></span>',
      '<mark data-color="red">**world**</mark> and ==this==',
      '**<mark data-color="red">world</mark>**',
      '`<mark data-color="red">` in code',
      'x < y and a <b>tag</b>',
    ])
      expect(readsCleanly(`Hello ${clean} there.`), clean).toBe(true);
  });

  it('reads a pathological line in time that grows with its length, not faster', () => {
    // Best of three, so a pause elsewhere doesn't count.
    const time = (text: string) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        readsCleanly(text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    for (const [name, line] of [
      [
        'emphasis beside colours',
        (n: number) => `${'*a'.repeat(n)} ${'<mark data-color="red">x</mark>'.repeat(n / 100)}`,
      ],
      ['tags left open', (n: number) => '<span '.repeat(n)],
      ['colours inside their own kind', (n: number) => '<mark data-color="red">'.repeat(n)],
      ['colour names alone', (n: number) => 'data-color'.repeat(n)],
      ['spaced list markers', (n: number) => '-  '.repeat(n)],
      [
        'marks inside a colour, then highlights left open',
        (n: number) => `<mark data-color="red">**x**</mark> ${'a== '.repeat(n)}`,
      ],
      [
        'lines of marks inside colours',
        (n: number) => '<mark data-color="red">**x** `y`</mark>\n'.repeat(n / 10),
      ],
      ['colours', (n: number) => '<mark data-color="red">x</mark>'.repeat(n)],
    ] as const) {
      const short = time(line(2_000));
      // Eight times as long takes about eight times as long; by its square, 64.
      expect(time(line(16_000)), name).toBeLessThan(24 * Math.max(short, 1));
    }
  });
});
