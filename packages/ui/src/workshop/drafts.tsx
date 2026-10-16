import { pluginDraftRoutes } from '@wikistow/contracts';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { Name } from '@/components/name';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormMessage } from '@/components/layout/auth-card';
import { ago } from '../agents/model';
import { chatStore } from '../ai/chat';
import { api } from '../api';
import { errorMessage } from '../errors';
import { WorkshopChat } from './workshop-chat';

type DraftSummary = pluginDraftRoutes.DraftSummary;

/** The person's plugin drafts (ADR 0004), most recently changed first. */
export const draftsQuery = queryOptions({
  queryKey: ['plugin-drafts'],
  queryFn: async () => (await api.call(pluginDraftRoutes.listDrafts)).drafts,
});

/** What a new draft starts from: nothing, a library version (`from`), or `files`. */
export type DraftStart = Omit<z.input<typeof pluginDraftRoutes.createDraft.body>, 'replaces'>;

/** Open the workshop on draft `draftId`, in place of any conversation, with its panel open. */
export function openWorkshop(draftId: string) {
  chatStore.start(new WorkshopChat(draftId));
  chatStore.setOpen(true);
}

/**
 * Make a draft and open the workshop on it. With 10 drafts already, the
 * person is asked first whether to delete the one changed longest ago,
 * named, which the server deletes with the new one made (`replaces`).
 * `start` settles once the workshop opens, or the person cancels; `dialog`
 * goes in the page.
 */
export function useNewDraft(): {
  start: (from: DraftStart) => Promise<void>;
  /** A draft is being made, or the person asked: don't start another. */
  busy: boolean;
  error: string | null;
  dialog: ReactNode;
} {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<{
    from: DraftStart;
    oldest: DraftSummary;
    done: () => void;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (from: DraftStart, replaces?: string) => {
    try {
      const { draft } = await api.call(pluginDraftRoutes.createDraft, {
        body: replaces ? { ...from, replaces } : from,
      });
      openWorkshop(draft.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      await queryClient.invalidateQueries({ queryKey: draftsQuery.queryKey });
    }
  };

  const [making, setMaking] = useState(false);
  const start = async (from: DraftStart) => {
    setError(null);
    setMaking(true);
    try {
      const drafts = await queryClient.fetchQuery({ ...draftsQuery, staleTime: 0 });
      const oldest = drafts.length >= pluginDraftRoutes.MAX_DRAFTS ? drafts.at(-1) : undefined;
      if (!oldest) return await create(from);
      return await new Promise<void>((done) => setAsking({ from, oldest, done }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setMaking(false);
    }
  };

  const close = () => {
    asking?.done();
    setAsking(null);
  };

  const dialog = (
    <Dialog open={asking !== null} onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete a draft to start this one?</DialogTitle>
          <DialogDescription>
            You have {pluginDraftRoutes.MAX_DRAFTS} drafts. Starting this one deletes “
            <Name>{asking?.oldest.name ?? ''}</Name>”, the one you changed longest ago.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (!asking) return;
              setBusy(true);
              void create(asking.from, asking.oldest.id).finally(() => {
                setBusy(false);
                close();
              });
            }}
          >
            Delete it and start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { start, busy: making || busy, error, dialog };
}

/** When a draft's files last changed, as the list says it. */
function changed(iso: string) {
  const said = ago(iso, new Date());
  return /^\d+ (min|h|d)$/.test(said) ? `Changed ${said} ago` : `Changed ${said}`;
}

/**
 * The person's drafts, with how long ago each changed, **Open** and
 * **Delete**, beside **New plugin**. The draft the workshop has open says
 * so, and can't be deleted while it is.
 */
export function DraftsList({ open }: { open: string | null }) {
  const queryClient = useQueryClient();
  const { data: drafts, error: listError } = useQuery(draftsQuery);
  const newDraft = useNewDraft();
  const [deleting, setDeleting] = useState<DraftSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (draft: DraftSummary) => {
    setError(null);
    try {
      await api.call(pluginDraftRoutes.deleteDraft, { params: { draftId: draft.id } });
    } catch (failure) {
      setError(errorMessage(failure));
    }
    await queryClient.invalidateQueries({ queryKey: draftsQuery.queryKey });
  };
  const shown = newDraft.error ?? error;
  return (
    <section aria-label="Plugin drafts" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-bold">Your plugin drafts</h2>
        <Button size="sm" disabled={newDraft.busy} onClick={() => void newDraft.start({})}>
          New plugin
        </Button>
      </div>
      {listError && <FormMessage>{errorMessage(listError)}</FormMessage>}
      {shown && <FormMessage>{shown}</FormMessage>}
      {drafts?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No drafts yet. Start a new plugin, and its files are saved here as the assistant writes
          them.
        </p>
      )}
      {drafts && drafts.length > 0 && (
        <ul className="grid gap-2">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              aria-label={draft.name}
              className="flex flex-wrap items-center gap-2 rounded-control border p-3 text-sm"
            >
              <strong className="min-w-0 truncate">
                <Name>{draft.name}</Name>
              </strong>
              <span className="flex-1 text-xs text-muted-foreground">
                {changed(draft.updatedAt)}
              </span>
              {draft.id === open ? (
                <Badge>Open</Badge>
              ) : (
                <>
                  <Button size="sm" variant="outline" onClick={() => openWorkshop(draft.id)}>
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(draft)}>
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {newDraft.dialog}
      <Dialog open={deleting !== null} onOpenChange={(next) => !next && !busy && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              “<Name>{deleting?.name ?? ''}</Name>” and its files are deleted from your WikiStow
              server. Versions you published stay in the library.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!deleting) return;
                setBusy(true);
                void remove(deleting).finally(() => {
                  setBusy(false);
                  setDeleting(null);
                });
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
