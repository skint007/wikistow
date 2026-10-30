import {
  copyOperations,
  spaceOperations,
  type FolderId,
  type PageId,
  type SpaceId,
  type moveOperations,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { copyNode } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { PLAIN, useClient } from '../vault/store';
import { refreshAccess, searchIndexChanged, spacesQuery } from '../data/queries';
import { isStale } from '../sharing/messages';
import { nameOf } from '../sharing/names';
import { describePerson, peopleQuery } from '../sharing/people';
import { ErrorLine, useAction } from '../sharing/use-action';
import { copyMessage, FinishUnknown, namedPages, PagesRefused } from './messages';
import { READ_BUDGET_MS } from './markdown-worker';
import type { Destination } from './move-model';
import { pageReader } from './page-reader';

/** Where the person chose to put it: a space, by the name they saw, and a place in it. */
export type Chosen = { spaceId: SpaceId; spaceName: string; place: Destination<FolderId> };

const REACH: Record<moveOperations.Reach, string> = {
  drafts: 'drafts and published versions',
  published: 'published versions',
};

const titleOf = (title: string | null) => (title?.trim() ? title : 'Untitled');

/**
 * A copy, or a move into another space (ADR 0007), worked out afresh: who
 * can open it there, who loses it, what arrives unpublished, links that
 * won't find their page, and for a move, what it ends. A move always asks,
 * even with asking before moves turned off, because it deletes. Then it
 * runs, showing how far it has got, and opens what it made.
 */
export function ConfirmCopy({
  sourceSpaceId,
  node,
  copy,
  chosen,
  onBack,
  onDone,
}: {
  sourceSpaceId: SpaceId;
  node: { id: FolderId | PageId; kind: 'folder' | 'page' };
  /** False for a move into another space. */
  copy: boolean;
  chosen: Chosen;
  onBack: () => void;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { busy, error, setError, run } = useAction((caught) => copyMessage(caught, copy));
  const [progress, setProgress] = useState<copyOperations.CopyProgress | null>(null);
  // The pages a refusal named, by source ID, and why.
  const [blocked, setBlocked] = useState<PagesRefused | null>(null);
  const [stopped, setStopped] = useState(false);
  // Its finish may have made it (`FinishUnknown`), so it isn't offered again.
  const [unsure, setUnsure] = useState(false);
  // Aborted by Stop; a new one for each try.
  const stopping = useRef<AbortController | null>(null);
  const [stopAsked, setStopAsked] = useState(false);
  // A preview's copy is tried once: after it fails or stops, the person looks again.
  const [spent, setSpent] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: [
      PLAIN,
      'copy-preview',
      copy,
      sourceSpaceId,
      node.id,
      chosen.spaceId,
      chosen.place.parentId,
    ],
    queryFn: ({ signal }) =>
      copyOperations.previewCopy(ctx, {
        kind: copy ? 'copy' : 'move',
        source: { spaceId: sourceSpaceId, nodeId: node.id },
        destination: { spaceId: chosen.spaceId, parentId: chosen.place.parentId },
        // Off the page's thread, given as long as the reader.
        read: (markdown) => pageReader.run('links', markdown, { budgetMs: READ_BUDGET_MS, signal }),
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    // Worked out again only by Look again: never while a copy runs, and
    // never as a fresh copy the person wasn't shown.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const shown = preview.data;
  const ends = shown?.ends;
  const ids = shown
    ? [
        ...(shown.audience?.kind === 'verified'
          ? shown.audience.people.map((p) => p.identityId)
          : []),
        ...shown.losses.map((c) => c.identityId),
        ...(ends?.shares.flatMap((s) => s.members) ?? []),
        ...(ends?.agentPicks.map((a) => a.personId) ?? []),
      ]
    : [];
  const { data: people } = useQuery(peopleQuery(ctx, ids));
  const name = (identityId: string) =>
    (people?.get(identityId) ?? describePerson(ctx, identityId, null)).name;
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const spaceName = (spaceId: SpaceId) =>
    nameOf(spaces?.find((s) => s.id === spaceId)?.metadata) ?? 'another space';
  // What is copied, by the names this app opened them by.
  const names = new Map(shown?.nodes.map((n) => [n.sourceId, titleOf(n.name)]));
  const named = (sourceId: string) => names.get(sourceId) ?? 'Untitled';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const where = (
    <>
      <Name>{chosen.spaceName}</Name>
      {chosen.place.path.map((folder, i) => (
        <Fragment key={i}>
          {' › '}
          <Name>{folder}</Name>
        </Fragment>
      ))}
    </>
  );
  const nothing = copy ? 'Nothing was copied.' : 'Nothing moved.';

  const go = (confirmed: copyOperations.CopyPreview) =>
    run(async () => {
      setSpent(confirmed.copyId);
      setBlocked(null);
      setStopped(false);
      setUnsure(false);
      const stop = new AbortController();
      stopping.current = stop;
      setStopAsked(false);
      setProgress({ stage: 'sending', sent: 0, total: confirmed.nodes.length });
      let made: copyOperations.MadeCopy | null = null;
      try {
        await runCommand(
          copyNode,
          { preview: confirmed },
          {
            satisfies: requirementsHere(),
            ctx,
            onProgress: setProgress,
            signal: stop.signal,
            onMade: (copied) => {
              made = copied;
            },
          },
        );
      } catch (caught) {
        // Stopped before its finish was sent: the copy is deleted.
        if (caught instanceof copyOperations.CopyStopped) {
          setStopped(true);
          return;
        }
        // Left for its finish, whose answer was lost or which stayed busy.
        if (caught instanceof copyOperations.CopyKept) {
          setUnsure(true);
          throw new FinishUnknown();
        }
        const pageIds = namedPages(caught);
        if (!pageIds) throw caught;
        // Both refusals naming pages are `forbidden`: a page the source's
        // tree lists with no version has nothing to copy.
        const { pages } = await spaceOperations.loadTree(ctx, sourceSpaceId).catch(() => ({
          pages: [],
        }));
        const empty = pages.filter((p) => p.draftHead === null && p.publishedHead === null);
        const refused = new PagesRefused(
          pageIds.every((id) => empty.some((p) => p.id === id))
            ? 'nothing-to-copy'
            : 'published-elsewhere',
          pageIds,
        );
        setBlocked(refused);
        throw refused;
      } finally {
        setProgress(null);
      }
      if (!made) return;
      const { spaceId, nodeId } = made;
      // Both trees, before opening what it made there.
      await queryClient.invalidateQueries({ queryKey: [PLAIN, 'tree'] });
      searchIndexChanged(queryClient, { spaceIds: [sourceSpaceId, spaceId] });
      // Closed first: a dialog left open would be shown again for the space it went to.
      onDone();
      await (node.kind === 'folder'
        ? navigate({
            to: '/s/$spaceId/f/$folderId',
            params: { spaceId, folderId: nodeId as FolderId },
          })
        : navigate({ to: '/s/$spaceId/p/$pageId', params: { spaceId, pageId: nodeId as PageId } }));
      // A move ended shares and links at the source.
      if (!copy) void refreshAccess(queryClient, ctx);
    });
  // It stops before the next node or attachment is sealed, and cancels the copy.
  const stop = () => {
    stopping.current?.abort();
    setStopAsked(true);
  };
  const lookAgain = () => {
    setError(null);
    setBlocked(null);
    setStopped(false);
    void preview.refetch();
  };
  const confirmable = shown !== undefined && !preview.isError && shown.copyId !== spent;
  // Once tried, unless it may have been made, or when the preview failed
  // other than for a change meanwhile, which goes back to choose again.
  const offerLookAgain =
    !busy &&
    !unsure &&
    ((shown !== undefined && shown.copyId === spent) ||
      (preview.isError && !isStale(preview.error)));
  // Focus moves on from a button that goes: from Stop, once it has run, to
  // Look again or Back; from Look again, once looked at again, to Copy or
  // Move. After a failed preview, Look again goes before Copy can be pressed.
  const footer = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const againButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const was = useRef({ busy, offerLookAgain });
  const toConfirm = useRef(false);
  useEffect(() => {
    if (was.current.busy && !busy) (againButton.current ?? backButton.current)?.focus();
    else if (was.current.offerLookAgain && !offerLookAgain) toConfirm.current = true;
    if (toConfirm.current && confirmable) {
      toConfirm.current = false;
      if (!footer.current?.contains(document.activeElement)) confirmButton.current?.focus();
    }
    was.current = { busy, offerLookAgain };
  }, [busy, offerLookAgain, confirmable]);

  return (
    <div className="grid gap-4">
      {/* Where focus goes after Next, so a screen reader starts with what is being confirmed. */}
      <h3 ref={heading} tabIndex={-1} className="text-sm outline-none">
        To{' '}
        <strong>
          {chosen.place.parentId === null ? (
            <>
              the top of <Name>{chosen.spaceName}</Name>
            </>
          ) : (
            where
          )}
        </strong>
        .
      </h3>
      {preview.error && (
        <ErrorLine
          error={
            isStale(preview.error)
              ? 'Something changed since you chose where it goes. Go back and check again.'
              : copyMessage(preview.error, copy, false)
          }
        />
      )}
      {!shown && !preview.error && (
        <p className="text-sm text-muted-foreground">Working out who can open it there…</p>
      )}
      {shown && (
        <>
          {shown.audience?.kind === 'verified' && (
            <section aria-label="Who can open it there" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">
                At least these people can open it there
              </h3>
              <ul className="grid gap-1 text-sm">
                {shown.audience.people.map((p) => (
                  <li key={p.identityId}>
                    <strong>
                      <Name>{name(p.identityId)}</Name>
                    </strong>{' '}
                    {p.reach === 'drafts' ? 'can edit it' : 'can read its published versions'}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                The server could keep someone with access from this list, so there may be more.
              </p>
            </section>
          )}
          {shown.audience?.kind === 'unlisted' && (
            <section aria-label="Who can open it there" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">Who can open it there</h3>
              <p className="text-sm">
                Everyone with access to <strong>{where}</strong>
                {shown.audience.shareId !== null && ', a shared folder'}. Only an owner of{' '}
                <Name>{chosen.spaceName}</Name> can see who.
              </p>
            </section>
          )}
          {!copy && (
            <section aria-label="Who loses access" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">These people lose access</h3>
              {shown.losses.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody.</p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {shown.losses.map((change) => (
                    <li key={change.identityId}>
                      <strong>
                        <Name>{name(change.identityId)}</Name>
                      </strong>{' '}
                      {change.after ? `keeps ${REACH[change.after]} only` : 'loses access'}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                {shown.audience?.kind === 'unlisted' &&
                  `Only an owner of ${plainText(chosen.spaceName)} sees who has access there, so some of them may have it there too. `}
                They keep anything they already read or downloaded.
              </p>
            </section>
          )}
          {shown.unpublished.length > 0 && (
            <section aria-label="Pages that arrive unpublished" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">
                These pages arrive unpublished
              </h3>
              <ul className="grid list-disc gap-1 pl-5 text-sm">
                {shown.unpublished.map((page) => (
                  <li key={page.pageId}>
                    <Name>{titleOf(page.title)}</Name>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                You can’t publish there, so only their drafts go. Someone who can publish there can
                publish them.
              </p>
            </section>
          )}
          {(shown.links === null || shown.links.length > 0) && (
            <section aria-label="Links that won’t work there" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">
                Links that won’t find their page there
              </h3>
              {shown.links === null ? (
                <p className="text-sm">Some links couldn’t be read, so some may not work there.</p>
              ) : (
                <ul className="grid list-disc gap-1 pl-5 text-sm">
                  {shown.links.map((link) => (
                    <li key={`${link.kind} ${link.page}`}>
                      <Name>{link.text}</Name>
                      {link.count > 1 && (
                        <span className="text-muted-foreground"> · {link.count} links</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                {/* Links that couldn't be read could be of either kind. */}
                {(shown.links?.some((link) => link.kind === 'wikilink') ?? true) &&
                  'Wikilinks to pages that don’t go with it each find a page with the same title there, if there is one. '}
                {(shown.links?.some((link) => link.kind !== 'wikilink') ?? !copy) &&
                  'Links to the address of a page or folder the move deletes, written so they can’t be pointed at its new place, stop working.'}
              </p>
            </section>
          )}
          {shown.inbound.length > 0 && (
            <section aria-label="Pages that link to it" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">
                Pages staying here that link to it
              </h3>
              <ul className="grid list-disc gap-1 pl-5 text-sm">
                {shown.inbound.map((page) => (
                  <li key={page.pageId}>
                    <Name>{titleOf(page.title)}</Name>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Their links stop working once it has moved.
              </p>
            </section>
          )}
          {ends && (
            <section aria-label="What the move ends" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">What the move ends</h3>
              <ul className="grid list-disc gap-1 pl-5 text-sm">
                {ends.publicLinks.map((pageId) => (
                  <li key={`link ${pageId}`}>
                    The public link of “<Name>{named(pageId)}</Name>”
                  </li>
                ))}
                {ends.publications.map(({ pageId, spaceId }) => (
                  <li key={`publication ${pageId} ${spaceId}`}>
                    “<Name>{named(pageId)}</Name>” published in <Name>{spaceName(spaceId)}</Name>:
                    the copy there stays, but isn’t updated from it any more
                  </li>
                ))}
                {ends.shares.map((share) => (
                  <li key={`share ${share.shareId}`}>
                    Sharing “<Name>{named(share.rootId)}</Name>”
                    {share.members.length > 0 && (
                      <>
                        {' '}
                        with{' '}
                        {share.members.map((member, i) => (
                          <Fragment key={member}>
                            {i > 0 && ', '}
                            <Name>{name(member)}</Name>
                          </Fragment>
                        ))}
                      </>
                    )}
                  </li>
                ))}
                {ends.agentPicks.map((agent) => (
                  <li key={`agent ${agent.agentId}`}>
                    <Name>{agent.name}</Name>, <Name>{name(agent.personId)}</Name>’s agent, loses
                    the folder it was given
                  </li>
                ))}
                <li>
                  Every earlier version: only each page’s current draft and published version go
                </li>
              </ul>
            </section>
          )}
          {!copy && (
            <p role="note" className="rounded-control bg-muted p-3 text-sm">
              <strong>A move can’t be undone.</strong> Once it’s there, it is deleted here, with
              everything listed above.
            </p>
          )}
        </>
      )}
      {progress !== null && (
        <div className="grid gap-2">
          <p role="status" className="text-sm font-bold">
            {progress.stage === 'finishing'
              ? 'Finishing… '
              : `${copy ? 'Copying' : 'Moving'}… ${progress.sent.toLocaleString()} of ${progress.total.toLocaleString()} done. `}
            Keep this open until it’s done.
          </p>
          <div
            role="progressbar"
            aria-label={copy ? 'Copy progress' : 'Move progress'}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.sent}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            {/* Set through the CSSOM, which the style policy allows. */}
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{
                width: `${progress.total > 0 ? (100 * progress.sent) / progress.total : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {stopped && (
        <p role="status" className="text-sm font-bold">
          Stopped. {nothing}
        </p>
      )}
      <ErrorLine error={error} />
      {blocked && (
        <ul
          aria-label={
            blocked.reason === 'published-elsewhere'
              ? 'Pages to detach first'
              : 'Pages with nothing to copy'
          }
          className="grid list-disc gap-1 pl-5 text-sm"
        >
          {blocked.pageIds.map((pageId) => (
            <li key={pageId}>
              <Name>{named(pageId)}</Name>
            </li>
          ))}
        </ul>
      )}
      <DialogFooter ref={footer}>
        {busy ? (
          // Only while it sends: once the finish is sent, it no longer stops.
          <Button
            variant="ghost"
            disabled={progress?.stage !== 'sending' || stopAsked}
            onClick={stop}
          >
            Stop
          </Button>
        ) : (
          <Button ref={backButton} variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        {offerLookAgain && (
          <Button ref={againButton} variant="secondary" onClick={lookAgain}>
            Look again
          </Button>
        )}
        <Button
          ref={confirmButton}
          disabled={busy || !confirmable}
          onClick={() => shown && void go(shown)}
        >
          {busy ? (copy ? 'Copying…' : 'Moving…') : copy ? 'Copy' : 'Move'}
        </Button>
      </DialogFooter>
    </div>
  );
}
