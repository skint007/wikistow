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
  const send = (from: Side, to: Side) => {
    const update = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc));
    for (const listener of to.before) listener();
    Y.applyUpdate(to.doc, update, 'remote');
  };
  const exchange = async () => {
    const [a, b] = sides as [Side, Side];
    for (let i = 0; i < 3; i++) {
      send(a, b);
      send(b, a);
      await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
    }
  };
  const bodyOf = (s: Side) => s.doc.getText('body').toJSON();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    for (const s of sides.splice(0)) s.binding.destroy();
    vi.useRealTimers();
  });

  // Two people with `page`, A's client before B's in Yjs's order, or after.
  const start = (page: string, aFirst: boolean) => {
    for (const s of sides.splice(0)) s.binding.destroy();
    const a = new Y.Doc();
    a.clientID = aFirst ? 1 : 2;
    a.getText('body').insert(0, page);
    const b = new Y.Doc();
    b.clientID = aFirst ? 2 : 1;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    sides = [side(a), side(b)];
    return sides as [Side, Side];
  };
  const orders = [true, false];

  const red = (tag: string, inner: string) => `<${tag} data-color="red">${inner}</${tag}>`;
  it.each([
    ['**==world==**', red('mark', '**world**'), red('span', '==**world**==')],
    ['**world**', red('mark', '**world**'), red('span', '**world**')],
    ['**world**', '==**world**==', red('span', '**world**')],
    ['==**world**==', red('mark', '**world**'), red('span', '==**world**==')],
  ])('from %s, merges as one side’s writing', async (was, mine, theirs) => {
    const page = (run: string) => `Hello ${run} there.\n\nNext.\n`;
    for (const aFirst of orders) {
      const [a, b] = start(page(was), aFirst);
      a.editor.shown = page(mine);
      b.editor.shown = page(theirs);
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect([page(mine), page(theirs)]).toContain(bodyOf(a));
      expect(a.editor.shown).toBe(bodyOf(a));
      expect(b.editor.shown).toBe(bodyOf(b));
    }
  });

  it('keeps typing just before and after a word someone formats meanwhile on its side', async () => {
    for (const [typed, merged] of [
      ['Hello big world there.\n', 'Hello big **world** there.\n'],
      ['Hello world! there.\n', 'Hello **world**! there.\n'],
      ['Hello worlds there.\n', 'Hello **world**s there.\n'],
    ] as const)
      for (const aFirst of orders) {
        const [a, b] = start('Hello world there.\n', aFirst);
        a.editor.shown = 'Hello **world** there.\n';
        b.editor.shown = typed;
        a.binding.write();
        b.binding.write();
        await exchange();
        expect(bodyOf(a)).toBe(merged);
        expect(bodyOf(b)).toBe(merged);
      }
  });

  it.each([
    // One inside the other's marks.
    ['**world**', '**==world==**', red('span', '**world**')],
    // One inside the other's tag.
    [
      '<mark>world</mark>',
      '<mark data-color="red">world</mark>',
      red('span', '<mark>world</mark>'),
    ],
    // A word, and a tag over it and the word before.
    ['big world', 'big **world**', red('mark', 'big world')],
    // Both take the same mark off.
    ['**world** and', 'world and', 'world and'],
  ])('from %s, settles each way of formatting it to one', async (was, mine, theirs) => {
    const page = (run: string) => `Hello ${run} there.\n`;
    for (const aFirst of orders) {
      const [a, b] = start(page(was), aFirst);
      a.editor.shown = page(mine);
      b.editor.shown = page(theirs);
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect([page(mine), page(theirs)]).toContain(bodyOf(a));
    }
  });

  it('settles formatting typed with words elsewhere on the line', async () => {
    const page = (run: string, end: string) => `Start ${run} end${end}\n`;
    for (const aFirst of orders) {
      const [a, b] = start(page('**==world==**', '.'), aFirst);
      a.editor.shown = page(red('mark', '**world**'), '.');
      b.editor.shown = page(red('span', '==**world**=='), '!');
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect([
        page(red('mark', '**world**'), '!'),
        page(red('span', '==**world**=='), '!'),
      ]).toContain(bodyOf(a));
    }
  });

  it('never takes out a run someone typed beside once they had it', async () => {
    for (const [was, formatted, at, typed, merged] of [
      ['Try a later.\n', 'Try **a** later.\n', 9, 'gain', 'Try **a**gain later.\n'],
      // Pasted after it: theirs, put in beside it, had it.
      ['Try a later.\n', 'Try **a** later.\n', 9, ' ==a==', 'Try **a** ==a== later.\n'],
      ['I think so.\n', '**I** think so.\n', 0, 'I', 'I**I** think so.\n'],
      [
        'Read the docs.\n',
        'Read **the** docs.\n',
        5,
        '**other** ',
        'Read **other** **the** docs.\n',
      ],
    ] as const) {
      const [a, b] = start(was, true);
      a.editor.shown = formatted;
      a.binding.write();
      await exchange();
      b.doc.transact(() => b.doc.getText('body').insert(at, typed));
      await exchange();
      expect(bodyOf(a)).toBe(merged);
      expect(bodyOf(b)).toBe(merged);
    }
  });

  it('keeps what a third person put in beside the run that goes', async () => {
    for (const [carol, merged] of [
      // A paragraph started after "world", some words, or marks around it.
      [(t: Y.Text) => t.insert(11, '\n\n'), ['\n\n ', '']],
      [(t: Y.Text) => t.insert(11, ' more'), [' more ', '']],
      [(t: Y.Text) => (t.insert(11, '**'), t.insert(6, '**')), [' ', '**']],
    ] as const)
      for (const aFirst of orders) {
        const [a, b] = start('Hello world there.\n', aFirst);
        const c = new Y.Doc();
        Y.applyUpdate(c, Y.encodeStateAsUpdate(a.doc));
        carol(c.getText('body'));
        a.editor.shown = 'Hello ~~world~~ there.\n';
        b.editor.shown = 'Hello ==world== there.\n';
        a.binding.write();
        b.binding.write();
        for (const s of [a, b]) Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(c), 'remote');
        await exchange();
        expect(bodyOf(a)).toBe(bodyOf(b));
        const [after, before] = merged;
        expect(
          ['~~world~~', '==world=='].map((run) => `Hello ${before}${run}${before}${after}there.\n`),
        ).toContain(bodyOf(a));
      }
  });

  it('writes an edit in its run before the run goes', async () => {
    for (const aFirst of orders) {
      const [a, b] = start('Hello world there.\n', aFirst);
      a.editor.shown = 'Hello **world** there.\n';
      b.editor.shown = 'Hello ==world== there.\n';
      a.binding.write();
      b.binding.write();
      send(a, b);
      // Before Bea's editor takes Al's in, she takes the "l" out.
      b.editor.shown = 'Hello ==word== there.\n';
      await vi.advanceTimersByTimeAsync(TAKE_MS * 2);
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect(bodyOf(a)).toContain('==word==');
    }
  });

  it('settles a run written before the editor showed theirs', async () => {
    for (const aFirst of orders) {
      const [a, b] = start('Hello **world** there.\n', aFirst);
      a.editor.shown = 'Hello world there.\n';
      a.binding.write();
      send(a, b);
      // Bea highlights it as her editor still shows it, bold.
      b.editor.shown = 'Hello ==**world**== there.\n';
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect(['Hello world there.\n', 'Hello ==**world**== there.\n']).toContain(bodyOf(a));
    }
  });

  it('formats words apart as runs apart, leaving the words between', async () => {
    for (const aFirst of orders) {
      const [a, b] = start('one middle three\n', aFirst);
      a.editor.shown = '**one** middle **three**\n';
      b.editor.shown = 'one three\n';
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe('**one** **three**\n');
      expect(bodyOf(b)).toBe('**one** **three**\n');
    }
  });

  it('keeps an edit among the words someone marks at once as they made it', async () => {
    for (const [mine, theirs, merged] of [
      [
        'The ==quick brown fox jumps over the== dog.\n',
        'The quick red fox jumps over the dog.\n',
        'The ==quick red fox jumps over the== dog.\n',
      ],
      [
        `The ${red('mark', 'quick brown fox')} jumps.\n`,
        'The quick fox jumps.\n',
        `The ${red('mark', 'quick fox')} jumps.\n`,
      ],
    ] as const)
      for (const aFirst of orders) {
        const [a, b] = start(mine.replace(/==|<[^>]*>/g, ''), aFirst);
        a.editor.shown = mine;
        b.editor.shown = theirs;
        a.binding.write();
        b.binding.write();
        await exchange();
        expect(bodyOf(a)).toBe(merged);
        expect(bodyOf(b)).toBe(merged);
      }
  });

  it('leaves code as text, and words parted by punctuation apart', async () => {
    for (const [was, mine, theirs, merged] of [
      // Literal HTML typed in code, while someone takes a letter out.
      [
        'A `say world now` b.\n',
        'A `say <em>world now` b.\n',
        'A `say word now` b.\n',
        'A `say <em>word now` b.\n',
      ],
      [
        '```\nsay world now\n```\n',
        '```\nsay <em>world</em> now\n```\n',
        '```\nsay word now\n```\n',
        '```\nsay <em>word</em> now\n```\n',
      ],
      // Each half of a word with a hyphen formatted by one of them.
      ['A foo-bar b.\n', 'A **foo**-bar b.\n', 'A foo-~~bar~~ b.\n', 'A **foo**-~~bar~~ b.\n'],
      // Typing after a word of one letter as it's formatted.
      ['Choose a item.\n', 'Choose **a** item.\n', 'Choose an item.\n', 'Choose **a**n item.\n'],
    ] as const)
      for (const aFirst of orders) {
        const [a, b] = start(was, aFirst);
        a.editor.shown = mine;
        b.editor.shown = theirs;
        a.binding.write();
        b.binding.write();
        await exchange();
        expect(bodyOf(a)).toBe(merged);
        expect(bodyOf(b)).toBe(merged);
      }
  });

  it('keeps a mark typed in a run, and a pasted phrase with the word', async () => {
    for (const aFirst of orders) {
      const [a, b] = start('Hello world there.\n', aFirst);
      a.editor.shown = 'Hello **world** there.\n';
      b.editor.shown = 'Hello ==wor\\=ld== there.\n';
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      // Beside the run, as typing in a word formatted meanwhile is, but there.
      expect(bodyOf(a)).toContain('\\=');
    }
    for (const aFirst of orders) {
      const [a, b] = start('Try world later.\n', aFirst);
      a.editor.shown = 'Try **world** later.\n';
      a.binding.write();
      b.doc.transact(() => b.doc.getText('body').insert(9, ' **world** again'));
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect(bodyOf(a).match(/world/g)).toHaveLength(2);
    }
  });

  it('formats a word that is only a mark', async () => {
    for (const aFirst of orders) {
      const [a, b] = start('Type = here.\n', aFirst);
      a.editor.shown = `Type ${red('mark', '=')} here.\n`;
      b.editor.shown = `Type ${red('span', '=')} here.\n`;
      a.binding.write();
      b.binding.write();
      await exchange();
      expect(bodyOf(a)).toBe(bodyOf(b));
      expect([`Type ${red('mark', '=')} here.\n`, `Type ${red('span', '=')} here.\n`]).toContain(
        bodyOf(a),
      );
    }
  });

  it('types a mark alone by character, as in code', () => {
    expect(ownChanges('a `world` b\n', 'a `<em>world` b\n')).toEqual([
      { from: 3, remove: 0, insert: '<em>' },
    ]);
    expect(ownChanges('x foo_bar y\n', 'x foo__bar y\n')).toEqual([
      { from: 6, remove: 0, insert: '_' },
    ]);
    expect(ownChanges('x1 y\n', 'x=1 y\n')).toEqual([{ from: 1, remove: 0, insert: '=' }]);
  });

  it('still types by character in a line someone else formats', () => {
    expect(ownChanges('Hello world.\n', 'Hello big world.\n')).toEqual([
      { from: 6, remove: 0, insert: 'big ' },
    ]);
    expect(ownChanges('A world.\n\nB.\n', 'A **world**.\n\nB!\n')).toEqual([
      { from: 2, remove: 5, insert: '**world**', run: true },
      { from: 11, remove: 1, insert: '!' },
    ]);
  });
});
