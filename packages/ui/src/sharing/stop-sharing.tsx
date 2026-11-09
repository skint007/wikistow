import { endingOperations, type ShareId, type SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState, type ReactNode } from 'react';
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
import { runCommand } from '../commands/command';
import { endShare } from '../commands/sharing-commands';
import { groupsQuery, refreshAccess, treeQuery } from '../data/queries';
import { PLAIN, useClient } from '../vault/store';
import { groupName } from './groups';
import { sharingMessage } from './messages';
import { shareName } from './names';
import { useOwnerRequirements } from './owner-standing';
import { describePerson, peopleQuery } from './people';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from './use-action';

// An ending's own words for the refusals that mean something else here.
const endingMessage = (error: unknown) =>
  error instanceof ApiError && error.code === 'payload-too-large'
    ? 'This folder is too big to stop sharing in one go.'
    : error instanceof ApiError && error.code === 'forbidden'
      ? 'Only an owner can stop sharing, and not while the folder is in the trash.'
      : sharingMessage(error);

/** "A", "A and B", "A, B and C". */
function listed(items: readonly ReactNode[]): ReactNode {
  return items.map((item, i) => (
    <Fragment key={i}>
      {i > 0 && (i === items.length - 1 ? ' and ' : ', ')}
      {item}
    </Fragment>
  ));
}

/**
 * Stop sharing a folder or the space (protocol section 6.9): who loses
 * access, what they keep and what ends, in a sentence or two, then
 * **Stop sharing**. Nothing is sealed before the owner confirms.
 * `onEnded` hears what to say once it is done.
 */
export function StopSharing({
  spaceId,
  shareId,
  rootId,
  heading = true,
  onCancel,
  onEnded,
}: {
  spaceId: SpaceId;
  shareId: ShareId;
  rootId: string | null;
  /** Off where the dialog's own title asks it already. */
  heading?: boolean;
  onCancel: () => void;
  onEnded: (message: ReactNode) => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { busy, error, setError, run } = useAction(endingMessage);
  const [records, setRecords] = useState<number | null>(null);
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const groups = useQuery(groupsQuery(ctx, spaceId));
  // Worked out afresh each time: it is what the owner confirms.
  const preview = useQuery({
    queryKey: [PLAIN, 'ending-preview', spaceId, shareId],
    queryFn: () => endingOperations.previewEnding(ctx, { spaceId, shareId }),
    staleTime: 0,
    gcTime: 0,
  });
  const { data: people } = useQuery(
    peopleQuery(ctx, [
      ...(preview.data?.people ?? []),
      ...(preview.data?.agents.map((a) => a.personId) ?? []),
    ]),
  );
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  const name = shareName(tree, rootId);
  const space = rootId === null;
  const title = (pageId: string) => tree?.pages.find((p) => p.id === pageId)?.title ?? null;

  const losing = preview.data
    ? [
        ...preview.data.people.map((id) => <Name key={id}>{person(id).name}</Name>),
        ...preview.data.groups.map((groupId) => {
          const group = groups.data?.groups.find((g) => g.groupId === groupId);
          return (
            <Fragment key={groupId}>
              the group <Name>{group ? groupName(group) : 'Unnamed group'}</Name>
            </Fragment>
          );
        }),
      ]
    : [];
  const agents = preview.data?.agents.length ?? 0;
  const ending = preview.data?.links.filter((l) => l.ends) ?? [];
  const staying = preview.data?.links.some((l) => !l.ends) ?? false;

  const stop = (shown: endingOperations.EndingPreview) =>
    run(async () => {
      let fromTrash = false;
      setRecords(0);
      try {
        await runCommand(
          endShare,
          { preview: shown },
          {
            satisfies,
            ctx,
            onProgress: ({ records: done }) => setRecords(done),
            onEnded: (ended) => (fromTrash = ended.fromTrash),
          },
        );
      } catch (caught) {
        // Access changed meanwhile: look at it again before stopping.
        if (caught instanceof ApiError && caught.code === 'permission-version') {
          await preview.refetch();
        }
        throw caught;
      } finally {
        setRecords(null);
      }
      await refreshAccess(queryClient, ctx);
      onEnded(
        <>
          Done. Only the space’s owners can open{' '}
          {space ? (
            'it'
          ) : (
            <>
              “<Name>{name}</Name>”
            </>
          )}{' '}
          now.
          {fromTrash &&
            ' Some of what was deleted from it is in the trash. Restore anything you want back before sharing the folder above.'}
        </>,
      );
    });

  return (
    <div className="grid gap-4">
      {heading && (
        <h3 className="font-extrabold">
          {space ? (
            'Stop sharing the space?'
          ) : (
            <>
              Stop sharing “<Name>{name}</Name>”?
            </>
          )}
        </h3>
      )}
      {preview.error && <ErrorLine error={endingMessage(preview.error)} />}
      {!preview.data && !preview.error && (
        <p className="text-sm text-muted-foreground">Looking at who has access…</p>
      )}
      {preview.data && (
        <section aria-label="What stopping sharing does" className="grid gap-2 text-sm">
          <p>
            {losing.length > 0 ? (
              <>
                {listed(losing)}
                {agents > 0 &&
                  (agents === 1 ? ', with an agent,' : `, with ${agents} agents,`)}{' '}
                {losing.length === 1 && agents === 0 ? 'loses' : 'lose'} access.
              </>
            ) : agents > 0 ? (
              <>{agents === 1 ? 'An agent loses' : `${agents} agents lose`} access.</>
            ) : (
              'Only the owners have access, so nobody loses it.'
            )}{' '}
            {(losing.length > 0 || agents > 0) &&
              `They keep what they already read or downloaded. Nothing saved from now on reaches them${staying ? ', except through the public links that stay' : ''}.`}
          </p>
          {ending.length > 0 && (
            <p>
              {ending.length === 1 ? 'The public link of ' : 'The public links of '}
              {listed(
                ending.map((l) => <Name key={l.pageId}>{title(l.pageId) ?? 'a page'}</Name>),
              )}{' '}
              {ending.length === 1 ? 'ends' : 'end'}.
            </p>
          )}
        </section>
      )}
      {records !== null && (
        <p role="status" className="text-sm font-bold">
          Stopping… {records} {records === 1 ? 'version' : 'versions'} done
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setError(null);
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy || !preview.data || preview.isFetching}
          onClick={() => preview.data && void stop(preview.data)}
        >
          Stop sharing
        </Button>
      </DialogFooter>
    </div>
  );
}

/** Stop sharing on its own, as Members and owners opens it from a shared folder's menu. */
export function StopSharingDialog({
  spaceId,
  share,
  onClose,
}: {
  spaceId: SpaceId;
  share: { shareId: ShareId; rootId: string | null } | null;
  onClose: () => void;
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { locked, hold } = useHoldOpen();
  const [done, setDone] = useState<ReactNode>(null);
  const close = () => {
    setDone(null);
    onClose();
  };
  return (
    <Dialog open={share !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent dialogClassName="sm:max-w-lg" locked={locked}>
        <HoldOpen value={hold}>
          <DialogHeader>
            <DialogTitle>
              {share?.rootId === null ? (
                'Stop sharing the space?'
              ) : (
                <>
                  Stop sharing “<Name>{shareName(tree, share?.rootId ?? null)}</Name>”?
                </>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Who loses access, and what ends.
            </DialogDescription>
          </DialogHeader>
          {done ? (
            <>
              <p role="status" className="text-sm font-bold">
                {done}
              </p>
              <DialogFooter>
                <Button onClick={close}>Close</Button>
              </DialogFooter>
            </>
          ) : (
            share && (
              <StopSharing
                spaceId={spaceId}
                shareId={share.shareId}
                rootId={share.rootId}
                heading={false}
                onCancel={close}
                onEnded={setDone}
              />
            )
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}
