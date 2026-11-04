/**
 * What Find on page looks for: the text typed, matched whatever its case
 * unless `matchCase`.
 */
export type FindQuery = { text: string; matchCase: boolean };

/** A match, by offset in the text searched: `from` to just before `to`. */
export type Match = { from: number; to: number };

/**
 * What a search found, for the bar to say: how many matches, and which of
 * them is the current one, from 0, or null when none is (the cursor moved
 * off it in an editor).
 */
export type Found = { count: number; current: number | null };

export const NOTHING_FOUND: Found = { count: 0, current: null };

// A no-break space matches a space, as it looks like one.
const NBSP = / /g;

/**
 * `text` as Find compares it, each character at its own offset: lower case
 * unless `matchCase`, where that keeps it one UTF-16 unit long (`İ` lowers
 * to two, so it stays as it is).
 */
export function folded(text: string, matchCase: boolean): string {
  const spaced = text.replace(NBSP, ' ');
  if (matchCase) return spaced;
  const lower = spaced.toLowerCase();
  if (lower.length === spaced.length) return lower;
  let out = '';
  for (const char of spaced) {
    const low = char.toLowerCase();
    out += low.length === char.length ? low : char;
  }
  return out;
}

/** Where `query` is in `text`, each match after the last one ends, as a browser's find counts them. */
export function matchesIn(text: string, query: FindQuery): Match[] {
  const sought = folded(query.text, query.matchCase);
  if (sought === '') return [];
  const searched = folded(text, query.matchCase);
  const found: Match[] = [];
  for (let at = searched.indexOf(sought); at !== -1; at = searched.indexOf(sought, at)) {
    found.push({ from: at, to: at + sought.length });
    at += sought.length;
  }
  return found;
}

/**
 * The match to go to from `index`, `by` one on, around the end to the
 * start (or the start to the end); null when there are none.
 */
export function stepped(count: number, index: number | null, by: 1 | -1): number | null {
  if (count === 0) return null;
  if (index === null) return by === 1 ? 0 : count - 1;
  return (index + by + count) % count;
}

/**
 * Which of `matches`, in order, to go to from `from` to `to` (a selection
 * or a match), `by` one on: the one it is if `by` is 0, else the next one
 * starting after it (or the one before it ends), around the end. Null
 * when there are none.
 */
export function matchFrom(
  matches: readonly Match[],
  at: { from: number; to: number },
  by: 0 | 1 | -1,
): number | null {
  if (matches.length === 0) return null;
  if (by === -1) {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i]!.from < at.from) return i;
    }
    return matches.length - 1;
  }
  const first = by === 0 ? at.from : at.from + 1;
  const index = matches.findIndex((match) => match.from >= first);
  return index === -1 ? 0 : index;
}

/** Whether `match` is just what `from`/`to` selects. */
export const isMatch = (match: Match | undefined, from: number, to: number) =>
  match !== undefined && match.from === from && match.to === to;

/** What the bar says of `found`, typed `text`: nothing until something is typed. */
export function foundText(found: Found, text: string): string {
  if (text === '') return '';
  if (found.count === 0) return 'No matches';
  if (found.current === null) return found.count === 1 ? '1 match' : `${found.count} matches`;
  return `${found.current + 1} of ${found.count}`;
}

/** Whether `event` is Find on page's key: Cmd+F on Apple systems, Ctrl+F elsewhere, with no other modifier. */
export const isFindKey = (
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
    key?: string | undefined;
  },
  apple: boolean,
) =>
  event.key?.toLowerCase() === 'f' &&
  (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey;
