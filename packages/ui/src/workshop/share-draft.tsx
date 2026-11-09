import { pluginDraftRoutes } from '@wikistow/contracts';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormMessage } from '@/components/layout/auth-card';
import { ApiError } from '@wikistow/client/api';
import { api } from '../api';
import { errorMessage } from '../errors';
import { PersonFinder } from '../sharing/person-finder';

/*
 * Shared plugin drafts (#315): the owner names people who read and change
 * a draft's files and run the workshop on it. Drafts are plain text on the
 * server, so no key is sealed to anyone: a person's key, changed or not,
 * doesn't matter here.
 */

type DraftSummary = pluginDraftRoutes.DraftSummary;

/** Drafts others shared with the person, with their owners' names. */
export const sharedDraftsQuery = queryOptions({
  queryKey: ['plugin-drafts', 'shared'],
  queryFn: async () => (await api.call(pluginDraftRoutes.listSharedDrafts)).drafts,
  // A server from before shared drafts answers 404: there are none.
  retry: false,
});

const sharesQuery = (draftId: string) =>
  queryOptions({
    queryKey: ['plugin-drafts', 'shares', draftId],
    queryFn: async () =>
      (await api.call(pluginDraftRoutes.getDraftShares, { params: { draftId } })).people,
  });

/**
 * **Share…** for one of the person's own drafts: whom it's shared with,
 * each with **Remove**, and the people picker to add someone.
 */
export function ShareDraft({
  draft,
  onClose,
}: {
  draft: DraftSummary | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const query = sharesQuery(draft?.id ?? '');
  const { data: people, error: readError } = useQuery({ ...query, enabled: draft !== null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (send: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await send();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    }
  };
  const close = () => {
    setError(null);
    onClose();
  };
  // A server from before shared drafts has no route for them: it answers 404 for a draft listed here.
  const old = readError instanceof ApiError && readError.status === 404;
  const shown =
    error ??
    (old
      ? 'Your WikiStow server doesn’t share plugin drafts yet.'
      : readError
        ? errorMessage(readError)
        : null);
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent dialogClassName="sm:max-w-lg" className="grid gap-4" locked={busy}>
        <DialogHeader>
          <DialogTitle>
            Share “<Name>{draft?.name ?? ''}</Name>”
          </DialogTitle>
          <DialogDescription>
            The people you share it with see it in their workshop. They can read and change its
            files and preview it, each with a conversation of their own, which goes if you remove
            them. Only you publish it or delete it. When two people change one file, the last change
            wins.
          </DialogDescription>
        </DialogHeader>
        {draft && !old && (
          <PersonFinder
            withAccess={false}
            submitLabel="Share"
            // Nothing is sealed to them, so a changed key needs no review.
            review={() => Promise.resolve('confirmed')}
            exclude={(person) =>
              people?.some((shared) => shared.identityId === person.id)
                ? 'It’s shared with them already.'
                : null
            }
            onFound={({ person }) =>
              void change(() =>
                api.call(pluginDraftRoutes.shareDraft, {
                  params: { draftId: draft.id },
                  body: { identityId: person.id },
                }),
              )
            }
          />
        )}
        {shown && <FormMessage>{shown}</FormMessage>}
        {people && people.length > 0 && (
          <ul aria-label="Shared with" className="grid gap-1.5 text-sm">
            {people.map((person) => (
              <li key={person.identityId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <Name>{person.name}</Name>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void change(() =>
                      api.call(pluginDraftRoutes.unshareDraft, {
                        params: { draftId: draft?.id ?? '', identityId: person.identityId },
                      }),
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {people?.length === 0 && (
          <p className="text-sm text-muted-foreground">It isn’t shared with anyone.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
