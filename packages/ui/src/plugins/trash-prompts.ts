/**
 * What a plugin asks to move to the trash (`host.pages.trash`): its name,
 * and each page's title with the names of the folders it is in, so two of
 * one title can be told apart.
 */
export type TrashRequest = {
  plugin: string;
  pages: readonly { title: string | null; folders: readonly string[] }[];
};

type Asked = TrashRequest & { id: number; answer: (agreed: boolean) => void };

/**
 * The plugins' requests to move pages to the trash (#404), asked one at a
 * time, in the order made, each once for all its pages. The shell draws
 * the one asked now (`PluginTrashPrompt`).
 */
function trashPrompts() {
  let waiting: Asked[] = [];
  let asks = 0;
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
          id: ++asks,
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
