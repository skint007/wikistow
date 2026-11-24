import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Y from 'yjs';
import {
  TAKE_MS,
  VisualBinding,
  type BoundEditor,
} from '../src/page/editor/visual/live-binding.ts';
import { REBASE_MS, WAIT_MS } from '../src/page/editor/visual/live-rebase.ts';
import { ownChanges, putInto } from '../src/page/editor/visual/live-text.ts';

// Two people formatting the same text at once in a live session (#720):
// one of them, the higher Yjs client, takes its own write out again and
// makes its formatting again over the other's text, which stays exactly as
// they wrote it. Here the editor's formatting is a change to its text it
// can make again on other text; the browser tests make it with ProseMirror.

type Format = (text: string) => string;

// A visual editor that shows what it takes in, and formats or types.
class FormatEditor implements BoundEditor {
  shown: string;
  #formats: Format[] = [];
  #typed = false;
  constructor(text: string) {
    this.shown = text;
  }
  written() {
    return this.shown;
  }
  taken: string[] = [];
  take(text: string) {
    this.taken.push(text);
    this.shown = text;
    this.#reset();
    return true;
  }
  show(text: string): true {
    this.shown = text;
    this.#reset();
    return true;
  }
  check() {
    return Promise.resolve({ visual: true, reason: null });
  }
  cantShow() {}
  canShow() {}
  format(format: Format) {
    this.shown = format(this.shown);
    this.#formats.push(format);
  }
  type(text: string) {
    this.shown = text;
    this.#typed = true;
  }
  captures = 0;
  intent() {
    const intent = this.#typed || this.#formats.length === 0 ? null : this.#formats;
    if (intent) this.captures++;
    this.#reset();
    return intent;
  }
  reapply(intents: readonly unknown[]) {
    for (const intent of intents) for (const format of intent as Format[]) this.format(format);
  }
  #reset() {
    this.#formats = [];
    this.#typed = false;
  }
}

const LOCAL = Symbol('local');

type Person = {
  doc: Y.Doc;
  text: Y.Text;
  editor: FormatEditor;
  binding: VisualBinding | null;
  before: Set<
    (sender: string | null, from?: { client: number | null; update: Uint8Array }) => void
  >;
  /** Its own changes, as the participant sends them, and how many each other person has. */
  log: Uint8Array[];
  sent: Map<Person, number>;
};

let everyone: Person[] = [];

/** People on one page, by Yjs client; `visual` false types in source mode. */
function people(page: string, ids: number[], visual = ids.map(() => true)): Person[] {
  const first = new Y.Doc();
  first.clientID = 1_000_000;
  first.getText('body').insert(0, page);
  const start = Y.encodeStateAsUpdate(first);
  everyone = ids.map((id, i) => {
    const doc = new Y.Doc();
    doc.clientID = id;
    Y.applyUpdate(doc, start);
    const text = doc.getText('body');
    const person: Person = {
      doc,
      text,
      editor: new FormatEditor(page),
      binding: null,
      before: new Set(),
      log: [],
      sent: new Map(),
    };
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) person.log.push(update);
    });
    if (visual[i])
      person.binding = new VisualBinding(
        {
          text,
          edit: (change) => doc.transact(change, LOCAL),
          onBeforeRemote: (listener) => {
            person.before.add(listener);
            return () => void person.before.delete(listener);
          },
          active: () => true,
        },
        person.editor,
      );
    return person;
  });
  return everyone;
}

/** What `from` has sent and `to` hasn't had, as one message. */
function send(from: Person, to: Person) {
  const had = from.sent.get(to) ?? 0;
  const fresh = from.log.slice(had);
  from.sent.set(to, from.log.length);
  if (fresh.length === 0) return;
  const update = Y.mergeUpdates(fresh);
  for (const listener of to.before)
    listener(`p${from.doc.clientID}`, { client: from.doc.clientID, update });
  Y.applyUpdate(to.doc, update, 'remote');
}

/** Everyone's messages to everyone, and the binding's timers, until nothing more goes. */
async function settle() {
  for (let round = 0; round < 20; round++) {
    for (const from of everyone) for (const to of everyone) if (from !== to) send(from, to);
    await vi.advanceTimersByTimeAsync(WAIT_MS + TAKE_MS);
    const quiet = everyone.every((p) =>
      everyone.every((q) => p === q || (p.sent.get(q) ?? 0) === p.log.length),
    );
    if (quiet) return;
  }
  throw new Error('It never settled');
}

const body = (person: Person) => person.text.toJSON();

/** Someone typing in source mode: their change, by the smallest change in characters. */
function source(person: Person, next: string) {
  const changes = ownChanges(body(person), next);
  person.doc.transact(() => putInto(person.text, changes), LOCAL);
}

/** As two Yjs docs merge each one's change from `page`, as main's binding writes them. */
function byCharacter(page: string, a: string, b: string, ids = [2, 1]): string {
  const docs = ids.map((id) => {
    const doc = new Y.Doc();
    doc.clientID = id;
    doc.getText('body').insert(0, '');
    return doc;
  });
  const first = new Y.Doc();
  first.clientID = 1_000_000;
  first.getText('body').insert(0, page);
  for (const doc of docs) Y.applyUpdate(doc, Y.encodeStateAsUpdate(first));
  const [x, y] = docs as [Y.Doc, Y.Doc];
  putInto(x.getText('body'), ownChanges(page, a));
  putInto(y.getText('body'), ownChanges(page, b));
  Y.applyUpdate(x, Y.encodeStateAsUpdate(y));
  return x.getText('body').toJSON();
}

const wrap =
  (word: string, open: string, close: string): Format =>
  (text) =>
    text.replace(word, `${open}${word}${close}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  for (const person of everyone.splice(0)) person.binding?.destroy();
  vi.useRealTimers();
});

describe('formatting made alongside someone else’s', () => {
  it('is made again over theirs by the higher client, theirs kept as written', async () => {
    const page = '**world**\n';
    const [a, b] = people(page, [2, 1]) as [Person, Person];
    a.editor.format(wrap('**world**', '<mark data-color="red">', '</mark>'));
    b.editor.format(wrap('**world**', '<span data-color="red">', '</span>'));
    a.binding?.write();
    b.binding?.write();
    expect(byCharacter(page, body(a), body(b))).toBe(
      '<span data-color="red"><mark data-color="red">**world**</span></mark>\n',
    );
    await settle();
    expect(body(a)).toBe('<span data-color="red"><mark data-color="red">**world**</mark></span>\n');
    expect(body(b)).toBe(body(a));
    expect(b.editor.shown).toBe(body(a));
  });

  it('takes out none of what the other person took out too', async () => {
    const page = 'Say ==world== now.\n';
    const [a, b] = people(page, [2, 1]) as [Person, Person];
    const highlight: Format = (text) =>
      text.replace('==world==', 'world').replace('world', '<mark data-color="red">world</mark>');
    a.editor.format(highlight);
    b.editor.format((text) => text.replace('==world==', '<span data-color="red">world</span>'));
    a.binding?.write();
    b.binding?.write();
    await settle();
    // Both took the `==` out; A's write, taken out again, doesn't bring it back.
    expect(body(a)).toBe(
      'Say <span data-color="red"><mark data-color="red">world</mark></span> now.\n',
    );
    expect(body(b)).toBe(body(a));
  });

  it('leaves it to the higher client, the lower taking in no merge meanwhile', async () => {
    const page = '**world**\n';
    const [a, b] = people(page, [2, 1]) as [Person, Person];
    a.editor.format(wrap('**world**', '<mark data-color="red">', '</mark>'));
    b.editor.format(wrap('**world**', '<span data-color="red">', '</span>'));
    a.binding?.write();
    b.binding?.write();
    send(a, b);
    await vi.advanceTimersByTimeAsync(TAKE_MS * 3);
    // B waits for A, which hasn't heard B's yet.
    expect(b.editor.taken).toEqual([]);
    send(b, a);
    await vi.advanceTimersByTimeAsync(1);
    // A takes its own out again and makes it again over B's at once.
    expect(body(a)).toBe('<span data-color="red"><mark data-color="red">**world**</mark></span>\n');
    send(a, b);
    await vi.advanceTimersByTimeAsync(TAKE_MS);
    expect(b.editor.taken).toEqual([body(a)]);
    expect(body(b)).toBe(body(a));
  });

  it('takes main’s merge in after a wait when the higher client only typed', async () => {
    const page = 'Hello world there.\n';
    const [a, b] = people(page, [2, 1]) as [Person, Person];
    a.editor.type('Hello World there.\n');
    b.editor.format(wrap('world', '<mark data-color="red">', '</mark>'));
    a.binding?.write();
    b.binding?.write();
    send(a, b);
    send(b, a);
    await vi.advanceTimersByTimeAsync(WAIT_MS - TAKE_MS);
    expect(b.editor.taken).toEqual([]);
    await settle();
    const main = byCharacter(
      page,
      'Hello World there.\n',
      'Hello <mark data-color="red">world</mark> there.\n',
    );
    expect(body(a)).toBe(main);
    expect(body(b)).toBe(main);
    expect(b.editor.shown).toBe(main);
  });

  it('makes nothing again of a write older than its window', async () => {
    const page = '**world**\n';
    const [a, b] = people(page, [2, 1]) as [Person, Person];
    a.editor.format(wrap('**world**', '<mark data-color="red">', '</mark>'));
    a.binding?.write();
    await vi.advanceTimersByTimeAsync(REBASE_MS);
    b.editor.format(wrap('**world**', '<span data-color="red">', '</span>'));
    b.binding?.write();
    const [wroteA, wroteB] = [body(a), body(b)];
    await settle();
    expect(body(a)).toBe(byCharacter(page, wroteA, wroteB));
    expect(body(b)).toBe(body(a));
  });

  it('makes nothing again over the person’s own change from elsewhere, as the source pane', async () => {
    const page = '**world**\n';
    const [a, b] = people(page, [2, 1]) as [Person, Person];
    a.editor.format(wrap('**world**', '<mark data-color="red">', '</mark>'));
    a.binding?.write();
    // In split view, the source pane, the same Yjs client, writes inside the tag.
    source(a, body(a).replace('red', 'blue'));
    b.editor.format(wrap('**world**', '<span data-color="red">', '</span>'));
    b.binding?.write();
    const [wroteA, wroteB] = [body(a), body(b)];
    await settle();
    expect(body(a)).toBe(byCharacter(page, wroteA, wroteB));
    expect(body(b)).toBe(body(a));
  });

  it('never takes out a third person’s typing, and everyone ends on one text', async () => {
    const page = 'Say world now.\n';
    const [a, b, c] = people(page, [3, 2, 1]) as [Person, Person, Person];
    for (let round = 0; round < 4; round++) {
      a.editor.format((text) => text.replace(/world/, `<mark data-color="red">world</mark>`));
      b.editor.format((text) => text.replace(/world/, `**world**`));
      c.editor.type(c.editor.shown.replace('now', `now Q${round}`));
      for (const p of [a, b, c]) p.binding?.write();
      send(a, b);
      send(c, a);
      send(b, c);
      await vi.advanceTimersByTimeAsync(TAKE_MS / 2);
      send(b, a);
      send(c, b);
      send(a, c);
    }
    await settle();
    expect(new Set([a, b, c].map(body)).size).toBe(1);
    for (let round = 0; round < 4; round++) expect(body(a)).toContain(`Q${round}`);
    // A bounded number of writes made again.
    expect(a.editor.captures).toBeLessThan(20);
  });
});
