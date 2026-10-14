import type { LinkablePage } from '@wikistow/client';
import { Check } from 'lucide-react';
import { Name } from '@/components/name';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { folderPath } from './link-model';

/**
 * Ask which page an ambiguous link means: every page with its title, by
 * where it sits. The pick is saved in the page's link table, so the link
 * keeps going there. A page not everyone who can open this one can open
 * can't be named, and is shown but can't be picked.
 */
export function LinkChooser({
  link,
  candidates,
  chosen,
  allowed,
  onPick,
  onOpenChange,
}: {
  link: { key: string; target: string } | null;
  candidates: readonly LinkablePage[];
  chosen: string | null;
  allowed: ReadonlySet<string> | null;
  onPick: (pageId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={link !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Which “<Name>{link?.target ?? ''}</Name>”?
          </DialogTitle>
          <DialogDescription>
            More than one page has this title. Links on this page written this way go to the one you
            choose.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1.5">
          {candidates.map((page) => {
            const blocked = allowed !== null && !allowed.has(page.id);
            const picked = page.id === chosen;
            return (
              <li key={page.id}>
                <button
                  type="button"
                  disabled={blocked}
                  aria-pressed={picked}
                  onClick={() => onPick(page.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-control border px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60',
                    picked &&
                      'border-primary bg-primary-soft text-primary-ink hover:bg-primary-soft',
                  )}
                >
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-bold">
                      <Name>{page.title ?? ''}</Name>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      <Name>{folderPath(page)}</Name>
                    </span>
                    {blocked && (
                      <span className="text-xs text-muted-foreground">
                        Not everyone who can open this page can open it.
                      </span>
                    )}
                  </span>
                  {picked && <Check className="size-4 shrink-0" strokeWidth={2} />}
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
