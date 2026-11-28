// Finding a change in What's new by the words in its highlights (#771).
import type { Release } from './changelog';

/** The words of what was typed, lowercased, in order; none for blank text. */
export const searchWords = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether a highlight holds every word, ignoring case and the backticks around code. */
export const highlightMatches = (item: string, words: readonly string[]) => {
  const plain = item.replaceAll('`', '').toLowerCase();
  return words.length > 0 && words.every((word) => plain.includes(word));
};

/** The release's highlights that hold every word, in the order it lists them. */
export const matchingHighlights = (release: Release, words: readonly string[]) =>
  release.highlights.flatMap(({ items }) => items.filter((item) => highlightMatches(item, words)));

/**
 * `text` in parts, each marked when it is one of `words`, ignoring case:
 * joined again, the parts are `text`.
 */
export function markWords(text: string, words: readonly string[]) {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return [{ text, marked: false }];
  // Longer words first, so one inside another marks the whole of it.
  escaped.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, marked: words.includes(part.toLowerCase()) }));
}
