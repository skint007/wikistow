// Finding a change in What's new by the words in its highlights (#771).
import type { Release } from './changelog';

/**
 * The words of what was typed, lowercased, in order, without backticks, as
 * highlights are matched without theirs; none for blank text.
 */
export const searchWords = (text: string) =>
  text.replaceAll('`', '').toLowerCase().split(/\s+/).filter(Boolean);

/** Whether a highlight holds every word, ignoring case and the backticks around code. */
export const highlightMatches = (item: string, words: readonly string[]) => {
  const plain = item.replaceAll('`', '').toLowerCase();
  return words.length > 0 && words.every((word) => plain.includes(word));
};

/** The release's highlights that hold every word, in the order it lists them. */
export const matchingHighlights = (release: Release, words: readonly string[]) =>
  release.highlights.flatMap(({ items }) => items.filter((item) => highlightMatches(item, words)));

/**
 * A highlight in parts, each in code or not, as backticks mark it, and
 * each in pieces, marked or not: every place a word occurs is marked, found in the text
 * without its backticks, as `highlightMatches` finds it, so a word that
 * runs into code or out of it is marked on both sides. Joined again, with
 * backticks around the code, the parts' pieces are `item`.
 */
export function highlightParts(item: string, words: readonly string[]) {
  const parts = item.split('`');
  const plain = parts.join('');
  const lower = plain.toLowerCase();
  // Marks by position, unless lowercasing changed the length (as for "İ").
  const marked = new Array<boolean>(plain.length).fill(false);
  if (lower.length === plain.length) {
    for (const word of words) {
      for (let at = lower.indexOf(word); word && at >= 0; at = lower.indexOf(word, at + 1)) {
        marked.fill(true, at, at + word.length);
      }
    }
  }
  let offset = 0;
  return parts.map((part, index) => {
    const pieces: { text: string; marked: boolean }[] = [];
    for (let at = 0; at < part.length;) {
      const on = marked[offset + at] ?? false;
      let end = at + 1;
      while (end < part.length && (marked[offset + end] ?? false) === on) end++;
      pieces.push({ text: part.slice(at, end), marked: on });
      at = end;
    }
    offset += part.length;
    return { code: index % 2 === 1, pieces };
  });
}
