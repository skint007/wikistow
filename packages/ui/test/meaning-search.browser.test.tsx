import { PageId, quantizeVector, RevisionId, searchOperations, SpaceId } from '@wikistow/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { setReader } from '../src/meaning/running.ts';
import {
  MEANING_PAUSE_MS,
  MeaningReader,
  useMeaningSearch,
  type MeaningResults,
} from '../src/meaning/search.ts';

const SPACE = SpaceId.parse('home');

/** Pages by title, each with its Markdown, and the vector its one passage has. */
const PAGES: Record<string, [string, number[]]> = {
  'Bean soup': ['---\ntags: [soup]\n---\nBeans and stock.', [1, 0, 0]],
  'Pea soup': ['---\ntags: [soup]\n---\nPeas and mint.', [0.95, 0.3, 0]],
  'Soup notes': ['Soup without tags.', [0.9, 0, 0.4]],
};

const idOf = (title: string) => title.toLowerCase().replace(/\W+/g, '-');

function indexOf() {
  const index = new searchOperations.PageIndex();
  for (const [title, [markdown]] of Object.entries(PAGES)) {
    const id = idOf(title);
    index.add(
      {
        spaceId: SPACE,
        pageId: PageId.parse(id),
        revisionId: RevisionId.parse(`${id}-r1`),
        parentId: null,
        folderIds: [],
        path: ['Home'],
        draft: false,
        unpublished: false,
      },
      { title, markdown },
    );
  }
  return index;
}

/** A reader of the kept vectors, with a model whose query vector is always the same. */
function readerOn() {
  const kept = new Map(
    Object.entries(PAGES).map(([title, [, vector]]) => [
      RevisionId.parse(`${idOf(title)}-r1`),
      [{ hash: title, start: 0, vector: quantizeVector(Float32Array.from(vector)) }],
    ]),
  );
  const state = { fail: false };
  const embed = vi.fn(async (_kind: 'query', texts: string[]) => {
    if (state.fail) throw new Error('The embedding worker stopped.');
    return { vectors: texts.map(() => Float32Array.from([1, 0, 0])) };
  });
  const load = vi.fn(async () => ({}));
  const file = vi.fn(async () => ({
    read: async () => new Uint8Array([1]),
    write: async () => {},
  }));
  const reader = new MeaningReader({
    embedder: { embed, load, stop: () => {} },
    file,
    open: () => kept,
    idle: async () => {},
  });
  const nearest = vi.spyOn(reader, 'nearest');
  setReader(reader);
  return { state, embed, load, file, nearest };
}

let cleanup = () => {};
afterEach(() => {
  cleanup();
  setReader(null);
});

/** Render `useMeaningSearch`, with what it gives last. */
async function probe(query: string, listed: readonly string[] = []) {
  const index = indexOf();
  const seen: { results: MeaningResults | null } = { results: null };
  function Probe(props: { query: string; listed: readonly string[] }) {
    seen.results = useMeaningSearch(index, props.query, props.listed);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: string, nextListed: readonly string[] = []) =>
    act(async () => root.render(<Probe query={next} listed={nextListed} />));
  await render(query, listed);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const titles = () => seen.results?.hits.map((hit) => hit.page.title) ?? [];
  return { render, titles };
}

const pause = () =>
  act(async () => {
    await new Promise((wait) => setTimeout(wait, MEANING_PAUSE_MS * 2));
  });

it('scans the vectors once a query vector and set of filters, not as the word matches change', async () => {
  const { nearest } = readerOn();
  const { render, titles } = await probe('warming');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup', 'Soup notes']);
  const scans = nearest.mock.calls.length;
  // With room for the pages listed by words, which it leaves out after.
  expect(nearest.mock.calls.at(-1)?.[2]).toBe(5);
  await render('warming', ['home/bean-soup']);
  expect(titles()).toEqual(['Pea soup', 'Soup notes']);
  await render('warming', ['home/bean-soup', 'home/pea-soup']);
  expect(titles()).toEqual(['Soup notes']);
  await render('warming');
  expect(titles()).toEqual(['Bean soup', 'Pea soup', 'Soup notes']);
  // It found every page there is: more listed asks no more of it.
  await render('warming', ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6', 'home/bean-soup']);
  expect(titles()).toEqual(['Pea soup', 'Soup notes']);
  expect(nearest).toHaveBeenCalledTimes(scans);
  // A filter changes what is scanned: once.
  await render('tag:soup warming');
  await render('tag:soup warming', ['home/pea-soup']);
  expect(titles()).toEqual(['Bean soup']);
  expect(nearest).toHaveBeenCalledTimes(scans + 1);
});

it('lists nothing by meaning once a query fails, rather than the last query’s pages', async () => {
  const { state } = readerOn();
  const { render, titles } = await probe('warming');
  await expect.poll(titles).toHaveLength(3);
  // The worker stops as the query changes.
  state.fail = true;
  await render('boiler service');
  await pause();
  expect(titles()).toEqual([]);
  state.fail = false;
  await render('boiler services');
  await expect.poll(titles).toHaveLength(3);
});

it('starts the model and reads the kept vectors only once the query searches pages', async () => {
  const { load, file } = readerOn();
  // Opened empty, or as the command palette, which searches no pages.
  const { render } = await probe('');
  await render('   ');
  await pause();
  expect(load).not.toHaveBeenCalled();
  expect(file).not.toHaveBeenCalled();
  await render('w');
  expect(load).toHaveBeenCalledOnce();
  await expect.poll(() => file.mock.calls.length).toBe(1);
  await render('wa');
  await render('warming');
  expect(load).toHaveBeenCalledOnce();
});
