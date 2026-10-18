import { Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { symbolWords } from '@/components/symbol-icon';
import { SYMBOL_LIST } from '@/components/symbol-set';
import { firstInGrid, moveInGrid } from './grid-keys';

const COLUMNS = 8;

/**
 * The picker's Icons tab: a search box over a grid of the whole icon set,
 * Lucide, by name and older names. Loaded only when the tab first opens,
 * like the emoji grid. Arrow keys move through the grid; Enter in the
 * search box picks the first match.
 */
export default function IconGrid({
  current,
  onPick,
  onRemove,
}: {
  current: string | null;
  onPick: (name: string) => void;
  /** Offers Remove icon while there is one. */
  onRemove: (() => void) | undefined;
}) {
  const [query, setQuery] = useState('');
  const words = query.toLowerCase().replaceAll('-', ' ').split(/\s+/).filter(Boolean);
  const found = SYMBOL_LIST.filter((icon) => words.every((word) => icon.words.includes(word)));
  const first = found[0];
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
            onPick(first.name);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            firstInGrid(grid)?.focus();
          }
        }}
        placeholder="Search icons"
        aria-label="Search icons"
      />
      <div
        ref={grid}
        onKeyDown={(event) => moveInGrid(event, { grid, search, columns: COLUMNS })}
        className="grid max-h-72 grid-cols-8 content-start overflow-y-auto pr-1"
      >
        {found.map((icon) => {
          const label = symbolWords(icon.name);
          return (
            <button
              key={icon.name}
              type="button"
              data-pick
              title={label}
              aria-label={label}
              aria-pressed={icon.name === current}
              onClick={() => onPick(icon.name)}
              className="grid size-8 place-items-center rounded-row outline-offset-[-2px] hover:tint active:tint-strong aria-pressed:bg-primary-soft"
            >
              <Icon icon={icon.data} aria-hidden strokeWidth={1.75} className="size-5" />
            </button>
          );
        })}
        {!first && (
          <p className="col-span-full py-4 text-center text-sm text-muted-foreground">
            No icons match.
          </p>
        )}
      </div>
      {current && onRemove && (
        <Button variant="outline" size="sm" onClick={onRemove}>
          Remove icon
        </Button>
      )}
    </div>
  );
}
