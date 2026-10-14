// `wikistow search`: the pages this agent can read whose title or text match.
import { searchOperations, type SpaceId } from '@wikistow/client';
import type { Io, Printer } from '../io.ts';
import type { Deps } from './agent.ts';
import { withAgent, type ContentArgs } from './content.ts';

/**
 * `search QUERY [--space S]`: the best matches among the pages this agent
 * can read, each from the version it sees (a draft, if it edits the page),
 * with a snippet. The index is built afresh, in memory, for each run.
 */
export async function search(
  io: Io,
  out: Printer,
  args: ContentArgs & { query: string; spaceId: SpaceId | null },
  deps: Deps,
) {
  const results = await withAgent(io, out, args, deps, async ({ ctx }) => {
    const index = await searchOperations.indexSpaces(
      ctx,
      args.spaceId === null ? {} : { spaceIds: [args.spaceId] },
    );
    return index.search(args.query).map(({ doc, title, snippet, score }) => ({
      pageId: doc.pageId,
      spaceId: doc.spaceId,
      title: title.text,
      draft: doc.draft,
      unpublished: doc.unpublished,
      snippet: snippet().text,
      score: Math.round(score * 1000) / 1000,
    }));
  });
  out.result({ results }, () => {
    if (results.length === 0) out.note('No pages match.');
    for (const hit of results) {
      const state = hit.draft ? '  [draft]' : hit.unpublished ? '  [unpublished]' : '';
      out.line(`${hit.pageId}  ${out.foreign(hit.title)}${state}  ${out.foreign(hit.snippet)}`);
    }
  });
}
