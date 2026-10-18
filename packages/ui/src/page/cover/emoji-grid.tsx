import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EMOJI_GROUPS } from './emoji-data';
import { parseGroups, searchEmoji } from './emoji-model';
import { firstInGrid, moveInGrid } from './grid-keys';

const GROUPS = parseGroups(EMOJI_GROUPS);
const COLUMNS = 8;

/**
 * The emoji picker's content: a search box over a grid of the bundled list.
 * Loaded only when the picker first opens, so the list isn't in the main
 * bundle. Arrow keys move through the grid; Enter in the search box picks
 * the first match.
 */
export default function EmojiGrid({
  current,
  onPick,
  onRemove,
}: {
  current: string | null;
  onPick: (emoji: string) => void;
  /** Offers Remove emoji while there is one. */
  onRemove: (() => void) | undefined;
}) {
  const [query, setQuery] = useState('');
  const groups = searchEmoji(GROUPS, query);
  const first = groups[0]?.entries[0];
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  return (
    <div className="grid gap-2">
      <Input
        ref={search}
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && first) {
            event.preventDefault();
            onPick(first.emoji);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            firstInGrid(grid)?.focus();
          }
        }}
        placeholder="Search emoji"
        aria-label="Search emoji"
      />
      <div
        ref={grid}
        onKeyDown={(event) => moveInGrid(event, { grid, search, columns: COLUMNS })}
        className="grid max-h-72 gap-2 overflow-y-auto pr-1"
      >
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title} className="grid gap-1">
            <h3 className="text-xs font-bold text-muted-foreground">{group.title}</h3>
            <div className="grid grid-cols-8">
              {group.entries.map((entry) => (
                <button
                  key={entry.emoji}
                  type="button"
                  data-pick
                  title={entry.words}
                  aria-label={entry.words}
                  aria-pressed={entry.emoji === current}
                  onClick={() => onPick(entry.emoji)}
                  className="grid size-8 place-items-center rounded-row text-xl outline-offset-[-2px] hover:tint active:tint-strong aria-pressed:bg-primary-soft"
                >
                  {entry.emoji}
                </button>
              ))}
            </div>
          </section>
        ))}
        {!first && (
          <p className="py-4 text-center text-sm text-muted-foreground">No emoji match.</p>
        )}
      </div>
      {current && onRemove && (
        <Button variant="outline" size="sm" onClick={onRemove}>
          Remove emoji
        </Button>
      )}
    </div>
  );
}
