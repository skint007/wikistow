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

  it('reads what’s open above a conflict on a long page quickly, leaving it where it can’t tell', async () => {
    for (const above of [
      '- item\n  ```\n  code\n  ```\n\nPara.\n\n'.repeat(2_000),
      '<pre>\nx\n</pre>\n\nPara.\n\n'.repeat(4_000),
      '<br>\n\nPara.\n\n'.repeat(8_000),
    ]) {
      const [was, mine, theirs] = [
        line('world'),
        line(hi('world')),
        line(red('span', 'world')),
      ].map((text) => `${above}${text}`) as [string, string, string];
      const started = Date.now();
      const result = await merged(was, mine, theirs, false);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect([byCharacter(was, mine, theirs, false), mine]).toContain(result);
    }
  });

  it('repairs many lines of one block in time that grows with their number, not faster', async () => {
    const lines = (n: number, run: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => `Line ${i} ${run(i)} end.`).join('\n') + '\n';
    // Past about 40 lines, or a busy machine's 50 ms, the editor's change
    // goes in as the whole block, which merges cleanly to one side.
    const time = async (n: number) => {
      const real = Date.now();
      const result = await merged(
        lines(n, () => 'world'),
        lines(n, () => hi('world')),
        lines(n, () => red('span', 'world')),
        false,
      );
      expect([lines(n, () => hi('world')), lines(n, () => red('span', 'world'))]).toContain(result);
      return Date.now() - real;
    };
    const short = await time(5);
    const result = await time(20);
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

  it('settles a list item after its fence, which the reader ends', async () => {
    const above = '- ```\n  literal\n  ```\n\n  ';
    const [was, mine, theirs] = [line('world'), line(hi('world')), line(red('span', 'world'))].map(
      (text) => `${above}${text}`,
    ) as [string, string, string];
    for (const aLower of orders)
      expect(await merged(was, mine, theirs, aLower)).toBe(aLower ? theirs : mine);
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

  it('keeps what main keeps: a lone `=` beside the tags, code after a fence in a list', async () => {
    const fenced = '- ```\n  -``\n\n  Hello <mk notes.md> there.\n  ```\n';
    for (const [was, mine, theirs] of [
      [line('scoreworld'), line(`score${hi('world')}`), line('score=world')],
      [fenced, fenced.replace('<mk', '<mrk'), fenced.replace('<mk', '<mak').replace('-``', '-```')],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('keeps a new line the other put in, and what it typed on the line offline', async () => {
    const was = line('abc def ghi');
    for (const aLower of orders) {
      const result = await merged(
        was,
        line(`${hi('abc def')} ghi`),
        line(`abc ${red('span', 'def ghi\nX')}`),
        aLower,
      );
      expect(result).toContain('\nX');
    }
    // The other typed a sentence on the line while away, then formatted the word.
    const away = ' I wrote this offline.';
    for (const aLower of orders) {
      const result = await merged(
        line('world'),
        line(hi('world')),
        line(red('span', 'world')).replace('there.', `there.${away}`),
        aLower,
      );
      expect(result).toContain(away);
      expect(readsCleanly(result)).toBe(true);
    }
  });

  it('settles a link or bold put on a word whose tag the merge split after its `<`', async () => {
    const page = 'See my notes here.\n';
    for (const [mine, theirs, both] of [
      [page.replace('my', hi('my')), page.replace('my', '[my](x.md)'), ''],
      [page.replace('my notes', hi('my notes')), page.replace('my', '**my**'), ''],
      [
        page.replace('my notes', hi('my notes')),
        page.replace('notes', '[notes](x.md)'),
        page.replace('my notes', hi('my [notes](x.md)')),
      ],
    ] as const)
      for (const aLower of orders) {
        const result = await merged(page, mine, theirs, aLower);
        expect(readsCleanly(result), `${result} ${aLower}`).toBe(true);
        expect([mine, theirs, both]).toContain(result);
      }
  });

  it('keeps what main keeps: tab-indented runs in code, email links, a highlight in a longer one', async () => {
    const fenced = '```html\nintro\n\nSee <mk notes.md> here.\n```\n';
    for (const [was, mine, theirs] of [
      [
        fenced,
        fenced.replace('<mk', '<mrk'),
        fenced.replace('<mk', '<mak').replace('intro', '\t```'),
      ],
      [
        'See <spn@example.com> here.\n',
        'See <spn@sample.com> here.\n',
        'See <span@example.com> here.\n',
      ],
      [
        'Say big world today.\n',
        `Say ${hi('big world today')}.\n`,
        `Say big ${hi('world')} today.\n`,
      ],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('settles bold or a link put on a short word, and a word after maths', async () => {
    for (const aLower of orders)
      for (const theirs of [line('**a**'), line('[a](notes.md)')]) {
        const mine = line(hi('a'));
        expect([mine, theirs]).toContain(await merged(line('a'), mine, theirs, aLower));
      }
    const above = '$$\nx$$\n\n';
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

  it('never leaves pieces of the other’s tag in a word, and keeps its sentences', async () => {
    for (const word of ['notes', 'make', 'some', 'now', 'and'])
      for (const aLower of orders) {
        const at = `See my ${word} here and more.\n`;
        const [mine, theirs] = [
          at.replace(` ${word} `, ` ${hi(word)} `),
          at.replace(` ${word} `, ` ${red('span', word)} `),
        ];
        expect([mine, theirs], word).toContain(await merged(at, mine, theirs, aLower));
      }
    for (const away of [' I wrote (this) offline.', ' See a/b, x = 5.', ' See (draft).'])
      for (const aLower of orders) {
        const result = await merged(
          line('world'),
          line(hi('world')),
          line(red('span', 'world')).replace('there.', `there.${away}`),
          aLower,
        );
        expect(result, away).toContain(away);
        expect(readsCleanly(result)).toBe(true);
      }
  });

  it('keeps what main keeps: doubled tags in code, a far link, a colour in a longer one', async () => {
    const code = 'See `<mark data-color="red">world</mark>` here.\n';
    const ref = 'Hello [ref](x) intro (tail)world there.\n';
    const nest = `Say big world now and <mark data-color="blue">y ${hi('c')}</mark>.\n`;
    for (const [was, mine, theirs] of [
      [
        code,
        code.replace('`<mark', '`<mark data-color="red"><mark'),
        code.replace('</mark>`', '</mark></mark>`'),
      ],
      [nest, nest.replace('big world', hi('big world')), nest.replace('big', hi('big'))],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
    // A third person's word in brackets before a link, as the formatting is settled.
    for (const aLower of orders) {
      const [a, b] = start(ref, aLower);
      const c = { doc: docOf('', 500, a.doc) };
      a.editor.shown = ref.replace('world', hi('world'));
      b.editor.shown = ref.replace('world', red('span', 'world'));
      a.binding.write();
      b.binding.write();
      const body = c.doc.getText('body');
      const at = body.toJSON().indexOf('tail');
      body.delete(at, 4);
      body.insert(at, 'NEW');
      await exchange([a, b, c]);
      for (const s of [a, b, c]) expect(bodyOf(s)).toContain('(NEW)');
      expect(readsCleanly(bodyOf(a))).toBe(true);
    }
  });

  it('settles code put on a word whose tag the code split', async () => {
    for (const aLower of orders) {
      const [mine, theirs] = [line(hi('mark')), line('`mark`')];
      expect([mine, theirs]).toContain(await merged(line('mark'), mine, theirs, aLower));
    }
  });

  it('never repairs a highlight taken off as the other colours it into losing the word', async () => {
    for (const word of ['data', 'color', 'mark', 'world'])
      for (const aLower of orders) {
        const was = line(hi(word));
        const [mine, theirs] = [line(word), line(red('span', hi(word), 'green'))];
        const result = await merged(was, mine, theirs, aLower);
        // Settled with the word, or left as main merged it.
        if (result !== byCharacter(was, mine, theirs, aLower)) {
          expect(readsCleanly(result), `${word} ${result}`).toBe(true);
          expect(result, word).toContain(`>${word}<`);
        }
      }
  });

  it('keeps what main keeps: a third person’s link address, a link title, maths', async () => {
    const title = '[click](dest "<mk value>")\n';
    const maths = '$$$\nx$$\n\n<mk value>\n$$$\n';
    for (const [was, mine, theirs] of [
      [title, title.replace('<mk', '<mrk'), title.replace('<mk', '<mak')],
      [maths, maths.replace('<mk', '<mrk'), maths.replace('<mk', '<mak')],
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
    const page = 'See [score](old)world there.\n';
    for (const aLower of orders) {
      const [a, b] = start(page, aLower);
      const c = { doc: docOf('', 500, a.doc) };
      a.editor.shown = page.replace('world', hi('world'));
      b.editor.shown = page.replace('world', red('span', 'world'));
      a.binding.write();
      b.binding.write();
      const body = c.doc.getText('body');
      const at = body.toJSON().indexOf('old');
      body.delete(at, 3);
      body.insert(at, 'new');
      await exchange([a, b, c]);
      for (const s of [a, b, c]) expect(bodyOf(s)).toContain('(new)');
    }
  });

  it('keeps what main keeps: code below a list item’s fence the reader ended', async () => {
    const fence = '```';
    const tag = '<span data-color="red">a</span>';
    const edits = (page: string) =>
      [page, page.replace('"red"', '"blue"'), page.replace('data-color', 'data-colour')] as const;
    for (const [was, mine, theirs] of [
      // The list's fence ends with its item; the page's that follows holds the line.
      [
        `- list\n\n  ${fence}\n  list code\n\n${fence}\n\nSee <mk value> here.\n\n${fence}\n`,
        `- list\n\n  ${fence}\n  list code\n\n${fence}\n\nSee <mrk value> here.\n\n${fence}\n`,
        `- list\n\n  ${fence}\n  list code\n\n${fence}\n\nSee <mak value> here.\n\n${fence}\n`,
      ],
      edits(`- item\n  ${fence}\n  a\n\n${fence}\nx\n\n${tag}\n${fence}\n`),
      // Three spaces is outside an item whose text starts at four: the page's fence.
      edits(
        `1.  item\n\n    ${fence}\n    a\n    ${fence}\n\n   ${fence}\nx\n\n${tag}\n${fence}\n`,
      ),
    ] as const)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('keeps a third person’s change to a link’s address beside the tags, the link highlighted', async () => {
    const page = `See [${hi('score')}](old)world there.\n`;
    for (const third of [500, 3_000])
      for (const aLower of orders) {
        const [a, b] = start(page, aLower);
        const c = { doc: docOf('', third, a.doc) };
        a.editor.shown = page.replace('world', hi('world'));
        b.editor.shown = page.replace('world', red('span', 'world', 'blue'));
        a.binding.write();
        b.binding.write();
        const body = c.doc.getText('body');
        const at = body.toJSON().indexOf('old');
        body.delete(at, 3);
        body.insert(at, 'new');
        await exchange([a, b, c]);
        for (const s of [a, b, c]) expect(bodyOf(s), `${third} ${aLower}`).toContain('(new)');
      }
  });

  it('keeps what main keeps: a tag farther into a link’s title', async () => {
    const page = 'See [a](x "title <mk value>") here.\n';
    const [mine, theirs] = [page.replace('<mk', '<mrk'), page.replace('<mk', '<mak')];
    for (const aLower of orders)
      expect(await merged(page, mine, theirs, aLower)).toBe(
        byCharacter(page, mine, theirs, aLower),
      );
  });

  it('settles crossed tags though the other deleted a word that names a colour', async () => {
    const was = 'Hello world and red.\n';
    const mine = `Hello ${hi('world')} and red.\n`;
    const theirs = `Hello ${red('span', 'world', 'blue')} and.\n`;
    for (const aLower of orders)
      expect(await merged(was, mine, theirs, aLower)).toBe(
        aLower ? theirs : `Hello ${hi('world')} and.\n`,
      );
  });

  it('settles crossed tags in a long paragraph with quotes', async () => {
    const above = 'This is one line. '.repeat(70);
    const page = (run: string) => `${above}Hello "${run}" there.\n`;
    for (const aLower of orders)
      expect(
        await merged(page('world'), page(hi('world')), page(red('span', 'world')), aLower),
      ).toBe(aLower ? page(red('span', 'world')) : page(hi('world')));
  });

  // Every order of three Yjs clients.
  const threeOrders = [
    [1_000, 2_000, 3_000],
    [1_000, 3_000, 2_000],
    [2_000, 1_000, 3_000],
    [2_000, 3_000, 1_000],
    [3_000, 1_000, 2_000],
    [3_000, 2_000, 1_000],
  ] as const;
  // A and B write `mine` and `theirs` of `was` at once, as C changes `body`
  // by `third`, as in source mode, each with its client of `ids`; what all
  // three settle to, and what main merges them to with no binding.
  const withThird = async (
    was: string,
    mine: string,
    theirs: string,
    third: (body: Y.Text) => void,
    ids: readonly [number, number, number],
  ) => {
    const plain = [docOf(was, ids[0])];
    plain.push(docOf(was, ids[1], plain[0]), docOf(was, ids[2], plain[0]));
    putInto((plain[0] as Y.Doc).getText('body'), ownChanges(was, mine));
    putInto((plain[1] as Y.Doc).getText('body'), ownChanges(was, theirs));
    third((plain[2] as Y.Doc).getText('body'));
    for (const from of plain)
      for (const to of plain) Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
    for (const s of sides.splice(0)) s.binding.destroy();
    const a = docOf(was, ids[0]);
    sides = [side(a), side(docOf(was, ids[1], a))];
    const c = { doc: docOf(was, ids[2], a) };
    const [sa, sb] = sides as [Side, Side];
    sa.editor.shown = mine;
    sb.editor.shown = theirs;
    sa.binding.write();
    sb.binding.write();
    third(c.doc.getText('body'));
    await exchange([sa, sb, c]);
    expect(bodyOf(sb)).toBe(bodyOf(sa));
    expect(bodyOf(c)).toBe(bodyOf(sa));
    return { got: bodyOf(sa), main: (plain[0] as Y.Doc).getText('body').toJSON() };
  };
  // `body`'s `from` changed to `to`, as by hand.
  const replace = (from: string, to: string) => (body: Y.Text) => {
    const at = body.toJSON().indexOf(from);
    body.delete(at, from.length);
    body.insert(at, to);
  };

  it('keeps what main keeps: tag text in HTML, a wikilink, a reference, after a byte order mark or a lone return', async () => {
    const pages = [
      '<div title="<mk value>">\nThere.\n</div>\n',
      'See [[Notes|<mk value>]] there.\n',
      '﻿```\nIntro\n\nSee <mk value> there.\n```\n',
      'Intro\r```\n\nSee <mk value> there.\n```\n',
      'See ![alt <mk value>](x.png) there.\n',
    ];
    for (const page of pages)
      for (const aLower of orders) {
        const [mine, theirs] = [page.replace('<mk', '<mrk'), page.replace('<mk', '<mak')];
        expect(await merged(page, mine, theirs, aLower), JSON.stringify(page)).toBe(
          byCharacter(page, mine, theirs, aLower),
        );
      }
    const page = 'See [x][<mk value>] there.\n';
    for (const ids of threeOrders) {
      const { got, main } = await withThird(
        page,
        page.replace('<mk', '<mrk'),
        page.replace('<mk', '<mak'),
        (body) => body.insert(body.length, '\n[<mark value>]: x\n'),
        ids,
      );
      expect(got, ids.join()).toBe(main);
    }
  });

  it('keeps a third person’s change to the address of a link the crossed tags are in', async () => {
    for (const page of ['See [world](old) there.\n', 'Hello [wor-world](old) there.\n'])
      for (const ids of threeOrders) {
        const { got } = await withThird(
          page,
          page.replace('world', hi('world')),
          page.replace('world', red('span', 'world', 'blue')),
          replace('(old)', '(new)'),
          ids,
        );
        expect(got, `${page} ${ids.join()}`).toContain('](new)');
      }
  });

  it('keeps a third person’s change to a link’s title on a line it repairs, and its typing', async () => {
    const page = 'See [score](old "title <mk value>") and world here.\n';
    for (const ids of threeOrders) {
      const { got } = await withThird(
        page,
        page.replace('world', hi('world')),
        page.replace('world', red('span', 'world', 'blue')),
        (body) => {
          replace('<mk', '<mark')(body);
          replace('here.', 'herex.')(body);
        },
        ids,
      );
      expect(got, ids.join()).toContain('title <mark value>');
      expect(got, ids.join()).toContain('herex.');
    }
    const title = `Hello world [x](u 'a <mark data-color="red">') there.\n`;
    for (const ids of threeOrders) {
      const { got } = await withThird(
        title,
        title.replace('world', hi('world')),
        title.replace('world', red('span', 'world', 'blue')),
        replace('"red">\'', '"blue">\''),
        ids,
      );
      expect(got, ids.join()).toContain(`'a <mark data-color="blue">'`);
    }
  });

  it('never leaves half of a mark a third person took off beside the tags', async () => {
    // Yjs doesn't say whose a deletion is: bold taken off right around the
    // tags can come back with the repair, whole (a limit), never in part.
    for (const [page, whole] of [
      ['Say **world** now.\n', true],
      ['Say **big**world now.\n', false],
      ['Say `big`world now.\n', false],
    ] as const)
      for (const ids of threeOrders) {
        const { got } = await withThird(
          page,
          page.replace('world', hi('world')),
          page.replace('world', red('span', 'world', 'blue')),
          (body) => {
            const marks = /\*\*|`/;
            for (let at = body.toJSON().search(marks); at >= 0; at = body.toJSON().search(marks))
              body.delete(at, body.toJSON()[at] === '`' ? 1 : 2);
          },
          ids,
        );
        const name = `${page} ${ids.join()}`;
        if (whole) expect(got.split('**').length % 2, name).toBe(1);
        else expect(got, name).not.toMatch(/\*\*|`/);
      }
  });

  it('keeps what main keeps: code indented in a quote or list item, tags after many backslashes', async () => {
    const cases: [string, string, string][] = [];
    for (const prefix of [
      '>     ',
      '-     ',
      '1.     ',
      '> >     ',
      '>\t\t',
      '-\t\t',
      '> -     ',
      '  >     ',
    ])
      cases.push([
        `${prefix}${line('world')}`,
        `${prefix}${line(hi('world'))}`,
        `${prefix}${line(red('span', 'world', 'blue'))}`,
      ]);
    const quoted = '- Example:\n\n>     <mark data-color="red">x</mark>\n\nNext.\n';
    cases.push([quoted, quoted.replace('red', 'blue'), quoted.replace('red', 'green')]);
    const later = '> Try this:\n>\n>     <mark data-color="red">x</mark>\n';
    cases.push([later, later.replace('red', 'blue'), later.replace('red', 'green')]);
    cases.push([
      'Example \\<mk data-color="red">\n',
      'Example \\<mrk data-color="red">\n',
      '>     Example <mak data-color="red">\n',
    ]);
    const slashes = `Example ${'\\'.repeat(65)}<mk data-color="red">\n`;
    cases.push([slashes, slashes.replace('<mk', '<mrk'), slashes.replace('<mk', '<mak')]);
    for (const [was, mine, theirs] of cases)
      for (const aLower of orders)
        expect(await merged(was, mine, theirs, aLower), JSON.stringify(was)).toBe(
          byCharacter(was, mine, theirs, aLower),
        );
  });

  it('keeps what main keeps: code indented before a quote marker', async () => {
    const page = '    > Hello <ak data-color="red">world there.\n';
    for (const aLower of orders) {
      const [mine, theirs] = [page.replace('<ak', '<mak'), page.replace('<ak', '<ark')];
      expect(await merged(page, mine, theirs, aLower)).toBe(
        byCharacter(page, mine, theirs, aLower),
      );
    }
    for (const prefix of ['    - ', '\t> ', '    1. ', '>     - ', '-     > ', '- > \t* ']) {
      const example = `Example:\n\n${prefix}Use <mark data-color="red">x</mark> here.\n`;
      for (const aLower of orders) {
        const [mine, theirs] = [example.replace('red', 'blue'), example.replace('red', 'green')];
        expect(await merged(example, mine, theirs, aLower), prefix).toBe(
          byCharacter(example, mine, theirs, aLower),
        );
      }
    }
  });

  it('keeps a third person’s brackets typed beside the tags and farther along', async () => {
    const page = 'Hello world there. More text here.\n';
    for (const ids of threeOrders) {
      const { got } = await withThird(
        page,
        page.replace('world', hi('world')),
        page.replace('world', red('span', 'world', 'blue')),
        (body) => {
          replace('here.', 'herex.')(body);
          replace(' text', ' [text]')(body);
          body.insert(body.toJSON().indexOf('world'), '[');
        },
        ids,
      );
      for (const typed of ['[text]', 'herex.']) expect(got, ids.join()).toContain(typed);
      expect(got.split('[').length, `${got} ${ids.join()}`).toBe(3);
    }
  });

  it('keeps a `$` a third person typed beside the tags', async () => {
    const page = 'It costs 50 today.\n';
    for (const ids of threeOrders) {
      const { got } = await withThird(
        page,
        page.replace('50', hi('50')),
        page.replace('50', red('span', '50', 'blue')),
        (body) => body.insert(body.toJSON().indexOf('50'), '$'),
        ids,
      );
      expect(got, ids.join()).toContain('$');
    }
  });

  it('keeps a sentence with a `$` a third person typed on the line, and the `$` beside the tags', async () => {
    const page = 'It costs 50 today.\n';
    for (const ids of threeOrders) {
      const { got } = await withThird(
        page,
        page.replace('50', hi('50')),
        page.replace('50', red('span', '50', 'blue')),
        (body) => {
          body.insert(body.toJSON().indexOf('50'), '$');
          body.insert(0, 'Total: $70 now. ');
        },
        ids,
      );
      expect(got, ids.join()).toContain('Total: $70 now. ');
      expect(got.split('$').length, `${got} ${ids.join()}`).toBe(3);
    }
  });

  it('never leaves a link’s brackets without its address when a third person took the link off', async () => {
    for (const [page, mine, theirs] of [
      [
        'See [world](x.md) there.\n',
        `See [${hi('world')}](x.md) there.\n`,
        `See [${red('span', 'world', 'blue')}](x.md) there.\n`,
      ],
      [
        'See [world](x.md) there.\n',
        `See ${hi('[world](x.md)')} there.\n`,
        `See ${red('span', '[world](x.md)', 'blue')} there.\n`,
      ],
    ] as const)
      for (const ids of threeOrders) {
        const { got } = await withThird(page, mine, theirs, replace('[world](x.md)', 'world'), ids);
        const brackets = (got.match(/[[\]()]/g) ?? []).join('');
        expect(['', '[]()'], `${got} ${ids.join()}`).toContain(brackets);
      }
  });

  it('takes in a source change to many paragraphs quickly within seconds of writing', async () => {
    const page =
      Array.from(
        { length: 900 },
        (_, i) => `Para ${i} \`<mark data-color="red">x</mark>\` end.`,
      ).join('\n\n') + '\n';
    const [a, b] = start(page, false);
    a.editor.shown = page.replace('Para 0', 'Para 0 now');
    a.binding.write();
    await exchange();
    const body = b.doc.getText('body');
    b.doc.transact(() => {
      const text = body.toJSON();
      for (let at = text.lastIndexOf(' end.'); at >= 0; at = text.lastIndexOf(' end.', at - 1))
        body.insert(at + 5, '!');
    });
    const started = Date.now();
    send(b, a);
    await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    const took = Date.now() - started;
    process.stderr.write(`many paragraphs: ${took} ms\n`);
    expect(took).toBeLessThan(150);
    expect(bodyOf(a)).toBe(bodyOf(b));
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
      [
        'closing tags written otherwise inside many colours',
        (n: number) =>
          `x <span data-color="blue">${'<mark data-color="red">'.repeat(n)}${'</span bogus>'.repeat(n)}${'</mark>'.repeat(n)}</span>`,
      ],
    ] as const) {
      const short = time(line(2_000));
      // Eight times as long takes about eight times as long; by its square, 64.
      expect(time(line(16_000)), name).toBeLessThan(24 * Math.max(short, 1));
    }
  });
});
