import type { Node } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect } from 'vite-plus/test';
import * as Y from 'yjs';
import { parseMarkdown } from '@wikistow/client/markdown';
import type { LiveSource, RemoteUpdate } from '../src/page/editor/source/live.ts';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { FORMATS, type FormatName } from '../src/page/editor/visual/formatting.ts';
import { setColor } from '../src/page/editor/visual/highlight-marks.ts';
import { ownChanges, putInto } from '../src/page/editor/visual/live-text.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';
import { pollActing } from './acting.ts';

// People in a live session, each in a visual editor mounted for real over
// a Yjs `body` of its own, sending each other their changes as the
// participant does (#720's tests).

const links: LinkAssist = {
  pages: [],
  targets: () => null,
  selfId: 'self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const LOCAL = Symbol('local');

export type Person = {
  doc: Y.Doc;
  text: Y.Text;
  live: LiveSource;
  before: Set<(sender: string | null, from?: RemoteUpdate) => void>;
  log: Uint8Array[];
  sent: Map<Person, number>;
  dom: HTMLElement;
  handle: EditorSurfaceHandle;
};

/** Unmount every editor mounted. */
export const unmounts: (() => void)[] = [];

/** A person on `page` under Yjs client `id`, the visual editor mounted. */
export async function person(page: string, id: number): Promise<Person> {
  const first = new Y.Doc();
  first.clientID = 1_000_000;
  first.getText('body').insert(0, page);
  const doc = new Y.Doc();
  doc.clientID = id;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(first));
  const text = doc.getText('body');
  const before = new Set<(sender: string | null, from?: RemoteUpdate) => void>();
  const log: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL) log.push(update);
  });
  const live: LiveSource = {
    text,
    edit: (change) => doc.transact(change, LOCAL),
    active: () => true,
    localOrigin: LOCAL,
    carets: () => [],
    onCarets: () => () => {},
    cursor: () => {},
    onBeforeRemote(listener) {
      before.add(listener);
      return () => void before.delete(listener);
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  await act(async () =>
    root.render(
      <StrictMode>
        <VisualSurface
          ref={ref}
          initial={page}
          onChange={() => {}}
          links={links}
          attachments={{ list: [], url: async () => null }}
          onFiles={() => {}}
          live={live}
        />
      </StrictMode>,
    ),
  );
  await pollActing(() => container.querySelectorAll('.ProseMirror').length).toBe(1);
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!ref.current || !dom) throw new Error('The editor did not mount');
  await act(() => expect.poll(() => viewOf(dom).state.doc.childCount).toBeGreaterThan(0));
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { doc, text, live, before, log, sent: new Map(), dom, handle: ref.current };
}

/** Someone typing in source mode under Yjs client `id`: no editor, `body` alone. */
export function sourcePerson(page: string, id: number): Person {
  const first = new Y.Doc();
  first.clientID = 1_000_000;
  first.getText('body').insert(0, page);
  const doc = new Y.Doc();
  doc.clientID = id;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(first));
  const log: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL) log.push(update);
  });
  return { doc, text: doc.getText('body'), before: new Set(), log, sent: new Map() } as never;
}

/** `p`, in source mode, makes its text `next`, by the smallest change. */
export function typeSource(p: Person, next: string) {
  p.doc.transact(() => putInto(p.text, ownChanges(p.text.toJSON(), next)), LOCAL);
}

/**
 * As main's binding would end: each person's own messages up to `counts`
 * of them, merged, with nothing made again.
 */
export function merged(page: string, people: readonly Person[], counts: readonly number[]): string {
  const first = new Y.Doc();
  first.clientID = 1_000_000;
  first.getText('body').insert(0, page);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(first));
  people.forEach((p, i) => {
    for (const update of p.log.slice(0, counts[i])) Y.applyUpdate(doc, update);
  });
  return doc.getText('body').toJSON();
}

/** Wait until `p`'s editor shows `text`, taken in. */
export const shows = (p: Person, text: string) => expect.poll(() => p.handle.read()).toBe(text);

/** What `from` has sent and `to` hasn't had, as one message. */
export function send(from: Person, to: Person) {
  const had = from.sent.get(to) ?? 0;
  const fresh = from.log.slice(had);
  from.sent.set(to, from.log.length);
  if (fresh.length === 0) return;
  const update = Y.mergeUpdates(fresh);
  for (const listener of to.before) listener('them', { client: from.doc.clientID, update });
  Y.applyUpdate(to.doc, update, 'remote');
}

const quiet = (people: Person[]) =>
  people.every((p) => people.every((q) => p === q || (p.sent.get(q) ?? 0) === p.log.length));

/** Everyone's messages to everyone, while any goes, and then until it settles. */
export async function settle(people: Person[]) {
  let still = 0;
  for (let round = 0; round < 60 && still < 8; round++) {
    for (const from of people) for (const to of people) if (from !== to) send(from, to);
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    still = quiet(people) ? still + 1 : 0;
  }
  if (still < 8) throw new Error('It never settled');
}

// Where `text` first is, as a range of the document.
export function range(doc: Node, text: string): [number, number] {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return;
    const i = (node.text ?? '').indexOf(text);
    if (i >= 0) at = pos + i;
  });
  if (at < 0) throw new Error(`No text ${text}`);
  return [at, at + text.length];
}

export type Edit = (p: Person) => void;

/** Colour `text` as the toolbar does: a highlight or text colour. */
export const colour =
  (text: string, kind: 'highlight' | 'text', color: 'red' | 'blue' | 'plain' | null): Edit =>
  (p) => {
    const view = viewOf(p.dom);
    const [from, to] = range(view.state.doc, text);
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      setColor(kind, color)(view.state, view.dispatch);
    });
  };

/** Put a format of the toolbar's on `text`, or take it off. */
export const toggle =
  (text: string, name: FormatName): Edit =>
  (p) => {
    const view = viewOf(p.dom);
    const [from, to] = range(view.state.doc, text);
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      FORMATS[name].run(view.state, view.dispatch);
    });
  };

/** Type `text` in place of what's at `at` in `word`, `remove` long, as the person does. */
export const typing =
  (word: string, at: number, remove: number, text: string): Edit =>
  (p) => {
    const view = viewOf(p.dom);
    const [from] = range(view.state.doc, word);
    act(() =>
      view.dispatch(
        text === ''
          ? view.state.tr.delete(from + at, from + at + remove)
          : view.state.tr.insertText(text, from + at, from + at + remove),
      ),
    );
  };

/** Whether the reader shows tags of `span` or `mark` as raw HTML. */
export const raw = (markdown: string) => {
  const stack: {
    type: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: unknown[];
  }[] = [parseMarkdown(markdown) as never];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const { start, end } = node.position ?? { start: {}, end: {} };
    const source = markdown.slice(start.offset ?? 0, end.offset ?? 0);
    if ((node.type === 'html' || node.type === 'text') && /<\/?(span|mark)\b/i.test(source))
      return true;
    if (node.children) stack.push(...(node.children as never[]));
  }
  return false;
};

/** As Yjs docs under clients `ids` merge each one's write from `page`, as main's binding writes them. */
export function byCharacter(
  page: string,
  writes: readonly string[],
  ids: readonly number[],
): string {
  const first = new Y.Doc();
  first.clientID = 1_000_000;
  first.getText('body').insert(0, page);
  const docs = ids.map((id, i) => {
    const doc = new Y.Doc();
    doc.clientID = id;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(first));
    putInto(doc.getText('body'), ownChanges(page, writes[i] ?? page));
    return doc;
  });
  const [merged] = docs as [Y.Doc];
  for (const doc of docs) Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc));
  return merged.getText('body').toJSON();
}

/** What one editor alone writes of `edit` on `page`. */
export async function alone(page: string, edit: Edit): Promise<string> {
  const p = await person(page, 99);
  edit(p);
  // An edit that changes nothing, as taking off a colour the text hasn't, writes nothing.
  await expect
    .poll(() => p.text.toJSON(), { timeout: 2_000 })
    .not.toBe(page)
    .catch(() => {});
  return p.text.toJSON();
}

/**
 * People under clients `ids` make `edits` at once, and send them once all
 * are in their `body`: what all end with, and main's merge.
 */
export async function together(page: string, edits: readonly Edit[], ids: readonly number[]) {
  const wrote: string[] = [];
  for (const edit of edits) wrote.push(await alone(page, edit));
  const main = byCharacter(page, wrote, ids);
  const people: Person[] = [];
  for (const id of ids) people.push(await person(page, id));
  edits.forEach((edit, i) => edit(people[i] as Person));
  await expect.poll(() => people.map((p) => p.text.toJSON())).toEqual(wrote);
  if (wrote.every((text) => text === page))
    await new Promise((resolve) => setTimeout(resolve, 300));
  await settle(people);
  const ends = people.map((p) => p.text.toJSON());
  for (const end of ends) expect(end).toBe(ends[0]);
  // Each editor shows what `body` holds.
  for (const p of people) expect(p.handle.read()).toBe(ends[0]);
  return { end: ends[0] as string, main, wrote };
}
