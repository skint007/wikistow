import { pageOperations, type ClientContext, type RevisionId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentName, agentPersonName } from '../agents/agent-name';
import { historyQuery, pageQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { readWikilinks } from './page-reader';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Published versions, newest first. Editors can restore one as the draft. */
export function HistorySheet({
  ctx,
  page,
  open,
  onOpenChange,
  canRestore,
  showing,
  beforeRestore,
  onRestored,
}: {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean;
  showing: RevisionId | null;
  /** Runs first; throwing stops the restore. */
  beforeRestore?: (() => Promise<void> | undefined) | undefined;
  /** Runs once the restored version is the draft. */
  onRestored?: (() => Promise<void>) | undefined;
}) {
  const { data: versions } = useQuery({ ...historyQuery(ctx, page), enabled: open });
  // Where readers' history starts, which editors are told and readers aren't.
  const { data: info } = useQuery(pageQuery(ctx, page.pageId));
  const readersFrom = info?.readerHistoryFrom ?? null;
  const unpublished = info?.role !== 'reader' && info?.heads.publishedHead === null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<RevisionId | null>(null);

  const view = (rev: RevisionId | undefined) => {
    onOpenChange(false);
    void navigate({
      to: '/s/$spaceId/p/$pageId',
      params: page,
      search: rev ? { rev } : {},
    });
  };

  async function restore(revisionId: RevisionId) {
    setRestoring(revisionId);
    setError(null);
    try {
      await beforeRestore?.();
      await pageOperations.restorePublished(ctx, page, revisionId, { read: readWikilinks });
      await onRestored?.();
      searchIndexChanged(queryClient);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pageQuery(ctx, page.pageId).queryKey }),
        queryClient.invalidateQueries({ queryKey: treeQuery(ctx, page.spaceId).queryKey }),
      ]);
      onOpenChange(false);
      void navigate({ to: '/s/$spaceId/p/$pageId', params: page, search: { view: 'draft' } });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right" className="grid content-start gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Published versions.
            {canRestore &&
              ' Restoring one makes it the draft; nothing changes for readers until it is published again.'}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {unpublished && versions && versions.length > 0 && (
          <p className="text-sm font-bold">
            The page is unpublished, so readers see none of these. If you publish it again, they see
            only what you publish from then on.
          </p>
        )}
        <ol className="grid gap-2">
          {versions?.map((version, index) => {
            const current = showing === version.revisionId || (showing === null && index === 0);
            // Readers lost the versions below this one when the page was unpublished.
            const readersStart =
              readersFrom !== null && readersFrom > 1 && version.publishedSeq === readersFrom;
            return (
              <Fragment key={version.revisionId}>
                <li className="grid gap-2 rounded-control bg-muted p-3">
                  <div className="flex items-baseline gap-2">
                    <span className="font-extrabold">Version {version.publishedSeq}</span>
                    {index === 0 && <span className="text-xs text-muted-foreground">latest</span>}
                  </div>
                  <p className="text-sm text-subtle-foreground">
                    {version.publisher.agentName !== null ? (
                      <AgentName
                        ctx={ctx}
                        agentId={version.publisher.identityId}
                        serverName={version.publisher.agentName}
                        person={agentPersonName(
                          ctx,
                          version.publisher.personId,
                          version.publisher.name,
                        )}
                      />
                    ) : version.publisher.name === null ? (
                      'Someone'
                    ) : (
                      <Name>{version.publisher.name}</Name>
                    )}{' '}
                    · {when(version.publishedAt)}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={current ? 'secondary' : 'outline'}
                      disabled={current}
                      onClick={() => view(index === 0 ? undefined : version.revisionId)}
                    >
                      {current ? 'Showing' : 'View'}
                    </Button>
                    {canRestore && index > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restoring !== null}
                        onClick={() => void restore(version.revisionId)}
                      >
                        {restoring === version.revisionId ? 'Restoring…' : 'Restore as draft'}
                      </Button>
                    )}
                  </div>
                </li>
                {readersStart && (
                  <li className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                    <span aria-hidden="true" className="h-px flex-1 bg-border" />
                    Readers see only the versions above
                    <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
        {versions?.length === 0 && (
          <p className="text-sm text-muted-foreground">Not published yet.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
