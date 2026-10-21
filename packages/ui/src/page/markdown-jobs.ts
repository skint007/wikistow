// What the Markdown worker (`markdown.worker.ts`) does, by name, and the
// messages to and from it. Each job takes and gives what structured clone
// copies: strings and plain objects.
import { findLinks, placedWikilinks } from '@wikistow/client/links';
import { linkSpans } from '@wikistow/client/markdown';
import { headingTexts, highlightCode, readBody } from '@wikistow/client/reader';
import { meaningOf, readerFidelity } from './editor/visual/reader-fidelity';

export const markdownJobs = {
  /**
   * A page body as the reader reads it (`readBody`), its code highlighted.
   * Only the worker loads highlight.js, which the page's thread needn't.
   */
  body: (body: string) => highlightCode(readBody(body)),
  /** A page's links where each is written, for export to rewrite (`linkSpans`). */
  spans: linkSpans,
  /** A page's wikilinks and links to pages, for the publish preview (`findLinks`). */
  links: findLinks,
  /** A page's wikilinks where each is written, for saving and publishing (`placedWikilinks`). */
  wikilinks: placedWikilinks,
  /** A page's headings, for a link to name (`headingTexts`). */
  headings: headingTexts,
  /** A body as the visual editor's check reads it, or why it stays in source mode (`readerFidelity`). */
  fidelity: readerFidelity,
  /** What the reader reads the visual editor's writing as, for the check to compare (`meaningOf`). */
  meaning: meaningOf,
};

export type MarkdownJobs = typeof markdownJobs;
export type MarkdownJob = keyof MarkdownJobs;

/** One job, posted to the worker once it is ready. */
export type MarkdownRequest = {
  [J in MarkdownJob]: { job: J; input: Parameters<MarkdownJobs[J]>[0] };
}[MarkdownJob];

export type MarkdownResponse =
  /** Sent once the worker's modules have loaded, so no job arrives before anything listens. */
  | { ready: true }
  | { ok: true; output: ReturnType<MarkdownJobs[MarkdownJob]> }
  /** The job threw: Markdown nested past the parser's stack, say. */
  | { ok: false };
