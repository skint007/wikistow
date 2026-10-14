export type EmojiEntry = { emoji: string; words: string };
export type EmojiGroup = { title: string; entries: EmojiEntry[] };

/** The bundled list's groups, each line "<emoji> <words>", as entries. */
export const parseGroups = (groups: readonly { title: string; emoji: string }[]): EmojiGroup[] =>
  groups.map(({ title, emoji }) => ({
    title,
    entries: emoji.split('\n').map((line) => {
      const space = line.indexOf(' ');
      return { emoji: line.slice(0, space), words: line.slice(space + 1) };
    }),
  }));

/**
 * The groups to show for a search: every group without one, else a single
 * group of the emoji whose words hold every word searched for (or that are
 * the emoji typed or pasted).
 */
export function searchEmoji(groups: readonly EmojiGroup[], query: string): EmojiGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  const found = groups
    .flatMap((group) => group.entries)
    .filter(
      (entry) =>
        entry.emoji.replace('️', '') === query.trim().replace('️', '') ||
        words.every((word) => entry.words.includes(word)),
    );
  return [{ title: 'Results', entries: found }];
}
