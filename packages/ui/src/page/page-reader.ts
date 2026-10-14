import type { ReadWikilinks } from '@wikistow/client';
import { vaultStore } from '../vault/store';
import type { MarkdownJobs } from './markdown-jobs';
import { MarkdownWorker, READ_BUDGET_MS } from './markdown-worker';

/**
 * The worker pages are read with as they're shown, by the reader and the
 * publish preview, and as they're saved: kept from page to page, and ended
 * when the vault locks, so nothing it read outlives the keys.
 */
export const pageReader = new MarkdownWorker();

// The worker the editor reads in, apart, so a slow page's reads there and
// a save's or the reader's don't wait on each other (`readToEdit`).
const editReader = new MarkdownWorker();

/**
 * The worker the visual editor's check reads a body in (`checkFidelity`):
 * apart, so it waits on nothing, and kept loaded, so it answers at once.
 */
export const checkReader = new MarkdownWorker();

vaultStore.subscribe(() => {
  if (vaultStore.get().status !== 'locked') return;
  for (const reader of [pageReader, editReader, checkReader]) reader.close();
});

/**
 * A page's wikilinks, read in `pageReader` and given as long as the reader,
 * for saving and publishing to work out its link table (`writeLinks`).
 */
export const readWikilinks: ReadWikilinks = (markdown) =>
  pageReader.run('wikilinks', markdown, { budgetMs: READ_BUDGET_MS });

// The reads under way in `editReader` that the next ones end.
const editing = { trim: new AbortController(), headings: new AbortController() };

/**
 * `markdown` read for the editor in a worker of its own, given as long as
 * the reader, as a read of `kind`. It ends (or skips, if not started) the
 * `ends` reads under way there: a slow page's read mustn't hold up the
 * next page's.
 */
function readToEdit<J extends 'wikilinks' | 'headings'>(
  job: J,
  markdown: string,
  kind: keyof typeof editing,
  ends: readonly (keyof typeof editing)[],
): Promise<ReturnType<MarkdownJobs[J]>> {
  for (const other of ends) editing[other].abort();
  const stop = (editing[kind] = new AbortController());
  return editReader.run(job, markdown, { budgetMs: READ_BUDGET_MS, signal: stop.signal });
}

/**
 * A draft's wikilinks as it opens, for its table to hold only what they use
 * (`linksInUse`). The draft opened before needs nothing more read for it.
 */
export const readOpeningLinks: ReadWikilinks = (markdown) =>
  readToEdit('wikilinks', markdown, 'trim', ['trim', 'headings']);

/**
 * The text of each heading of a page's Markdown (`headingTexts`), for `[[#`
 * completion; none if it can't be read. Only the newest completion is
 * shown, so it ends the heading read before it, but not the draft's trim.
 */
export const readHeadings = (markdown: string): Promise<string[]> =>
  readToEdit('headings', markdown, 'headings', ['headings']).catch(() => []);
