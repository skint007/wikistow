import type { Marked, searchOperations } from '@wikistow/client';

/** Marked text cut into runs, each marked or not, in order. */
export function markedParts({ text, highlights }: Marked): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const { start, end } of [...highlights].sort((a, b) => a.start - b.start)) {
    // Overlapping or out-of-range highlights mark only what is left of the text.
    const from = Math.max(at, start);
    const to = Math.min(text.length, end);
    if (to <= from) continue;
    if (from > at) parts.push({ text: text.slice(at, from), mark: false });
    parts.push({ text: text.slice(from, to), mark: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/** Where a page is, as search shows it: each name, or what stands for one that can't be opened. */
export const breadcrumb = (path: searchOperations.SearchPage['path']) =>
  path.map((name) => name ?? 'Unreadable folder').join(' / ');

/** What the search dialog says above its results. */
export function searchStatus({
  index,
  progress,
  query,
  results,
}: {
  index: { size: number } | undefined;
  progress: searchOperations.IndexProgress | undefined;
  query: string;
  results: number;
}): string {
  if (!index) {
    return progress && progress.total > 0
      ? `Indexing ${progress.pages} of ${progress.total} page${progress.total === 1 ? '' : 's'}`
      : 'Finding your pages…';
  }
  if (index.size === 0) return 'There are no pages to search yet.';
  if (!query.trim()) return 'Search the titles and text of every page you can read.';
  if (results === 0) return 'No pages match.';
  return `${results} page${results === 1 ? '' : 's'}`;
}

/** Apple systems, where shortcuts take Cmd (and Ctrl+K deletes to the line's end in text). */
export const isApple = () =>
  /Mac|iPhone|iPad|iPod/.test(
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
      navigator.platform,
  );

/** The search shortcut: Cmd+K on Apple systems, Ctrl+K elsewhere, with no other modifier. */
export const isSearchKey = (
  // Autofill sends keydown events with no key at all.
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
    key?: string | undefined;
  },
  apple: boolean,
) =>
  event.key?.toLowerCase() === 'k' &&
  (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey;
