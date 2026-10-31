import { changeLabel, pageOperations, type ClientContext, type RevisionId } from '@wikistow/client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
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
import {
  historyQuery,
  pageQuery,
  searchIndexChanged,
  treeQuery,
  versionChangesQuery,
} from '../data/queries';
import { errorMessage } from '../errors';
import { readWikilinks } from './page-reader';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** How many versions history lists at first, and adds each time more are asked for. */
const LISTED = 20;

type Version = Awaited<ReturnType<typeof pageOperations.loadHistory>>[number];

/**
 * Published versions, newest first, the newest `LISTED` until more are
 * asked for. Editors can restore one as the draft. A version made by
 * changes while reading says what changed, and a run of them by one
 * publisher folds into its newest (ADR 0008).
 */
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
  const [listed, setListed] = useState(LISTED);
  // Runs shown whole, by their newest version.
  const [unfolded, setUnfolded] = useState<ReadonlySet<RevisionId>>(new Set());
  const shown = versions?.slice(0, listed) ?? [];
  // Only the versions listed are opened, each once.
  const { data: changes } = useQuery({
    ...versionChangesQuery(
      ctx,
      page,
      shown.map((version) => version.revisionId),
    ),
    enabled: open && shown.length > 0,
    placeholderData: keepPreviousData,
  });
  const changeOf = (version: Version) => changes?.get(version.revisionId) ?? null;
  const isCurrent = (version: Version) =>
    showing === version.revisionId || (showing === null && version === shown[0]);
  // Readers lost the versions below this one when the page was unpublished.
  const readersStart = (version: Version) =>
    readersFrom !== null && readersFrom > 1 && version.publishedSeq === readersFrom;

  // Runs of versions made by changes while reading, by one publisher. The
  // version readers' history starts at is in none, so its line stays in
  // place. Every other version is a run of one.
  const runs: Version[][] = [];
  for (const version of shown) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    const joins =
      run !== undefined &&
      last !== undefined &&
      changeOf(last) !== null &&
      changeOf(version) !== null &&
      last.publisher.identityId === version.publisher.identityId &&
      !readersStart(last) &&
      !readersStart(version);
    if (joins) run.push(version);
    else runs.push([version]);
  }
  const toggle = (newest: RevisionId) =>
    setUnfolded((before) => {
      const after = new Set(before);
      if (!after.delete(newest)) after.add(newest);
      return after;
    });

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
          {runs.map((run) => {
            const [newest] = run;
            if (!newest) return null;
            // The version viewed is never folded away.
            const whole = run.slice(1).some(isCurrent);
            const open = whole || unfolded.has(newest.revisionId);
            const earlier = run.length - 1;
            return (open ? run : [newest]).map((version) => {
              const index = shown.indexOf(version);
              const current = isCurrent(version);
              const change = changeOf(version);
              return (
                <Fragment key={version.revisionId}>
                  <li className="grid gap-2 rounded-control bg-muted p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="font-extrabold">Version {version.publishedSeq}</span>
                      {index === 0 && <span className="text-xs text-muted-foreground">latest</span>}
                    </div>
                    {change && <p className="text-sm">{changeLabel(change)}</p>}
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
                    <div className="flex flex-wrap gap-2">
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
                      {version === newest && earlier > 0 && !whole && (
                        <Button
                          size="sm"
                          variant="link"
                          className="px-0"
                          aria-expanded={open}
                          onClick={() => toggle(newest.revisionId)}
                        >
                          {open ? 'Hide' : 'Show'} {earlier} earlier{' '}
                          {earlier === 1 ? 'change' : 'changes'} while reading
                        </Button>
                      )}
                    </div>
                  </li>
                  {readersStart(version) && (
                    <li className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                      Readers see only the versions above
                      <span aria-hidden="true" className="h-px flex-1 bg-border" />
                    </li>
                  )}
                </Fragment>
              );
            });
          })}
        </ol>
        {versions && versions.length > listed && (
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() => setListed((before) => before + LISTED)}
          >
            Show older versions
          </Button>
        )}
        {versions?.length === 0 && (
          <p className="text-sm text-muted-foreground">Not published yet.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
