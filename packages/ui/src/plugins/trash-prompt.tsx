import { useSyncExternalStore } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { pageTitle } from '../shell/sidebar';

/** What a plugin asks to move to the trash (`host.pages.trash`): its name, and each page's title. */
export type TrashRequest = { plugin: string; titles: readonly (string | null)[] };

type Asked = TrashRequest & { answer: (agreed: boolean) => void };

/**
 * The plugins' requests to move pages to the trash (#404), asked one at a
 * time, in the order made, each once for all its pages. The shell draws
 * the one asked now (`PluginTrashPrompt`).
 */
function trashPrompts() {
  let waiting: Asked[] = [];
  const listeners = new Set<() => void>();
  const changed = (next: Asked[]) => {
    waiting = next;
    for (const listener of listeners) listener();
  };
  return {
    /**
     * Ask the person: true once they agree, false if they say no or
     * `signal` aborts first, as the plugin unloads or the vault locks.
     */
    ask(request: TrashRequest, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        const asked: Asked = {
          ...request,
          answer: (agreed) => {
            signal.removeEventListener('abort', gone);
            changed(waiting.filter((each) => each !== asked));
            resolve(agreed);
          },
        };
        const gone = () => asked.answer(false);
        signal.addEventListener('abort', gone, { once: true });
        changed([...waiting, asked]);
      });
    },
    current: (): Asked | null => waiting[0] ?? null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const pluginTrashPrompts = trashPrompts();

/** The request asked now, if any: one prompt listing every page it would move to the trash. */
export function PluginTrashPrompt() {
  const asked = useSyncExternalStore(pluginTrashPrompts.subscribe, pluginTrashPrompts.current);
  const count = asked?.titles.length ?? 0;
  const pages = count === 1 ? 'this page' : `these ${count} pages`;
  return (
    <Dialog open={asked !== null} onOpenChange={(open) => !open && asked?.answer(false)}>
      {asked && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Move {count === 1 ? 'a page' : `${count} pages`} to the trash?
            </DialogTitle>
            <DialogDescription>
              <Name>{asked.plugin}</Name> asks to move {pages} to the trash.{' '}
              {count === 1
                ? 'It stays there for 30 days, and you can restore it from Trash until then. Any public link to it ends.'
                : 'They stay there for 30 days, and you can restore them from Trash until then. Any public links to them end.'}
            </DialogDescription>
          </DialogHeader>
          <ul
            aria-label="Pages to move to the trash"
            className="grid max-h-64 list-disc gap-1 overflow-y-auto pl-5 text-sm"
          >
            {/* Titles may repeat: each in the plugin's order. */}
            {asked.titles.map((title, i) => (
              <li key={`${i}`}>
                <Name>{pageTitle(title)}</Name>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => asked.answer(false)}>
              Keep {count === 1 ? 'it' : 'them'}
            </Button>
            <Button variant="destructive" onClick={() => asked.answer(true)}>
              Move to trash
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
