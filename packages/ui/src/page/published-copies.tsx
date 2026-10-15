import type { pageOperations, SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { endPublication } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import {
  publishedCopiesQuery,
  sharedWithMeQuery,
  spacesQuery,
  type ListedCopy,
} from '../data/queries';
import { nameOf } from '../sharing/names';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';
import { endMessage } from './messages';
import { placesOf, readsAs, type Step } from './published-copies-model';

/**
 * Where each copy is (`placesOf`), while `shown`, or null until it can be
 * said. Only a space whose name the person can't read needs their spaces
 * and shared folders, so only then are those loaded. Should either fail,
 * the places are named without it.
 */
export function usePlaces(
  copies: readonly ListedCopy[],
  shown: boolean,
): Map<SpaceId, Step[]> | null {
  const ctx = useClient();
  const needed = shown && copies.some((published) => published.spaceName === null);
  const { data: spaces, isLoading: loadingSpaces } = useQuery({
    ...spacesQuery(ctx),
    enabled: needed,
    refetchOnWindowFocus: false,
  });
  const { data: shared, isLoading: loadingShared } = useQuery({
    ...sharedWithMeQuery(ctx),
    enabled: needed,
    refetchOnWindowFocus: false,
  });
  const loading = loadingSpaces || loadingShared;
  return useMemo(() => {
    if (loading) return null;
    const folders = new Map<string, (string | null)[]>();
    for (const item of shared ?? []) {
      // A whole space shared with them is one of their spaces.
      if (item.share.rootId === null) continue;
      const { spaceId } = item.share;
      folders.set(spaceId, [...(folders.get(spaceId) ?? []), nameOf(item.root)]);
    }
    return placesOf(copies, { spaces: new Set(spaces?.map((s) => s.id)), folders });
  }, [copies, spaces, shared, loading]);
}

/** A place (`placesOf`), each name isolated from the words around it. */
export function Place({ steps }: { steps: Step[] }) {
  return steps.map((step, i) => (
    <Fragment key={i}>
      {i > 0 && ' › '}
      {step.map((part, j) => (typeof part === 'string' ? part : <Name key={j}>{part.name}</Name>))}
    </Fragment>
  ));
}

/**
 * What ending a copy did. Another copy listed may now read as this one did,
 * its number gone, so it says how many are left.
 */
function endedText(where: string, ended: boolean, left: number): string {
  const done = ended ? `Ended the copy in ${where}.` : `The copy in ${where} had already ended.`;
  if (left === 0) return `${done} None are left.`;
  return `${done} ${left === 1 ? '1 other is' : `${left} others are`} still listed.`;
}

/**
 * A place within a sentence: the app's own words there start in lower case,
 * "an" before what it can't read.
 */
function inSentence(place: Step[]): string {
  const text = readsAs(place);
  if (typeof place[0]?.[0] !== 'string') return text;
  const lower = text.charAt(0).toLowerCase() + text.slice(1);
  return lower.startsWith('unreadable') ? `an ${lower}` : lower;
}

const ABOUT: Record<ListedCopy['copy']['state'], string> = {
  live: 'It gets the versions published to it from this page.',
  blocked: 'Somewhere there you can’t publish, so it doesn’t say which page it is.',
};

/**
 * Where a page is published in other spaces (protocol section 13), for
 * someone who can publish it, each with End, which asks first: the copy
 * stays there as a page of its own, which this page no longer updates.
 * Opened from the page's "Published in" pill; it loads the list again as
 * it opens, since ending goes by space, whatever copy is there by then, and
 * ends a copy only once it has (not `unknown` or `checking`).
 */
export function PublishedCopiesDialog({
  page,
  title,
  copies,
  unknown,
  refused,
  checking,
  onRetry,
  open,
  onOpenChange,
}: {
  page: pageOperations.PageRef;
  title: string;
  copies: ListedCopy[];
  /** The list didn't load as it is now, so `copies` may be out of date. */
  unknown: boolean;
  /** It was refused: this person can no longer publish the page. */
  refused: boolean;
  /** The list is loading again, so `copies` may be about to change. */
  checking: boolean;
  /** Load the list again, and say how that went. */
  onRetry: () => Promise<'loaded' | 'failed' | 'refused'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { locked, hold } = useHoldOpen();
  // What happened, said and focused, since the focused item or button goes
  // with it. Each saying is new, so the same words twice are said twice.
  const [said, setSaid] = useState<{ text: string; n: number } | null>(null);
  // Only while open: what finishes after it closes isn't said when it opens again.
  const shown = useRef(open);
  shown.current = open;
  const say = (text: string) => {
    if (shown.current) setSaid((last) => ({ text, n: (last?.n ?? 0) + 1 }));
  };
  const status = useRef<HTMLParagraphElement>(null);
  const checkingId = useId();
  useLayoutEffect(() => {
    if (said) status.current?.focus();
  }, [said]);
  // Said where focus goes, since the list it was in goes with it.
  useEffect(() => {
    if (open && refused) {
      say('You can no longer publish this page, so you can’t see or end its copies.');
    }
  }, [open, refused]);
  const { spaceId, pageId } = page;
  useEffect(() => {
    // Cleared as it closes, so it opens with nothing said.
    if (!open) {
      setSaid(null);
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: publishedCopiesQuery(ctx, { spaceId, pageId }).queryKey,
    });
  }, [open, queryClient, ctx, spaceId, pageId]);
  const places = usePlaces(copies, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" locked={locked}>
        <HoldOpen value={hold}>
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                Where “<Name>{title}</Name>” is published
              </DialogTitle>
              <DialogDescription>
                Copies of this page in other spaces. Each gets only the versions published to it
                from this page.
              </DialogDescription>
            </DialogHeader>
            {/* In the page while empty too, so a screen reader announces what arrives. */}
            <p
              ref={status}
              role="status"
              tabIndex={said ? -1 : undefined}
              className={said ? 'text-sm font-bold outline-none' : 'sr-only'}
            >
              {said?.text}
            </p>
            {unknown && !refused && (
              <div className="grid justify-items-start gap-2">
                <ErrorLine error="Couldn’t check where it’s published just now. Try again before ending a copy." />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void onRetry().then((result) => {
                      // Refused, it says so itself.
                      if (result === 'loaded') say('Checked again.');
                      if (result === 'failed') say('Still couldn’t check. Try again in a moment.');
                    })
                  }
                >
                  Try again
                </Button>
              </div>
            )}
            {checking && !unknown && places !== null && copies.length > 0 && (
              <p id={checkingId} className="text-sm text-muted-foreground">
                Checking where it’s published, before a copy can be ended…
              </p>
            )}
            {refused ? null : places === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : copies.length === 0 ? (
              !unknown && (
                <p className="text-sm text-muted-foreground">
                  This page isn’t published in any other space.
                </p>
              )
            ) : (
              <ul className="grid gap-3">
                {copies.map((published) => {
                  const place = places.get(published.spaceId) ?? [];
                  return (
                    <CopyItem
                      key={published.spaceId}
                      source={page}
                      published={published}
                      place={place}
                      canEnd={!unknown}
                      // One End at a time, each on the list as it is now.
                      current={!unknown && !checking && !locked}
                      checkingId={checking && !unknown ? checkingId : undefined}
                      // Not while something runs here, whose outcome must be seen.
                      canOpen={!locked}
                      onOpenCopy={() => onOpenChange(false)}
                      onEnded={(was, left) => {
                        const where = inSentence(place);
                        say(endedText(where, was, left));
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

function CopyItem({
  source,
  published,
  place,
  canEnd,
  current,
  checkingId,
  canOpen,
  onOpenCopy,
  onEnded,
}: {
  source: pageOperations.PageRef;
  published: ListedCopy;
  place: Step[];
  /** Whether End is offered: not while the list couldn't load. */
  canEnd: boolean;
  /** Whether the list is as it is now, so End it may go ahead. */
  current: boolean;
  /** What says the list is loading again, while it is. */
  checkingId: string | undefined;
  canOpen: boolean;
  onOpenCopy: () => void;
  /** After End, whether there was a copy there to end. */
  onEnded: (ended: boolean, left: number) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction(endMessage);
  const [confirming, setConfirming] = useState(false);
  const endButton = useRef<HTMLButtonElement>(null);
  const placeLine = useRef<HTMLParagraphElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const { copy } = published;
  const id = useId();
  const where = inSentence(place);
  const query = publishedCopiesQuery(ctx, source);
  const end = () =>
    run(async () => {
      try {
        await runCommand(
          endPublication,
          { source, spaceId: published.spaceId },
          {
            satisfies: requirementsHere(),
            ctx,
            onEnded: (ended) => {
              // Gone at once, even if the list doesn't load again.
              const left = queryClient.setQueryData(query.queryKey, (listed) =>
                listed?.filter((other) => other.spaceId !== published.spaceId),
              );
              onEnded(ended, left?.length ?? 0);
            },
          },
        );
      } finally {
        // Listed as it is now, whether or not it went through.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: query.queryKey }),
          queryClient.invalidateQueries({ queryKey: [PLAIN, 'tree'] }),
        ]);
      }
    });
  return (
    <li aria-labelledby={`${id}-place`} className="grid gap-1.5 rounded-control border p-3 text-sm">
      <p ref={placeLine} id={`${id}-place`} tabIndex={-1} className="font-bold outline-none">
        <Place steps={place} />
      </p>
      <p className="text-muted-foreground">{ABOUT[copy.state]}</p>
      {confirming && (
        <p id={`${id}-confirm`}>
          End this copy? It stays there as a page of its own, and its readers keep it. This page
          won’t update it any more, and publishing this page there again makes a new page.
        </p>
      )}
      <ErrorLine error={error} />
      <div className="flex gap-2">
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              ref={confirmButton}
              aria-describedby={[`${id}-confirm`, checkingId].filter(Boolean).join(' ')}
              // Only while the list is current, since ending goes by space.
              // Unavailable rather than disabled, so it keeps focus meanwhile.
              aria-disabled={busy || !current}
              className="aria-disabled:cursor-wait aria-disabled:opacity-50"
              autoFocus
              onClick={() => {
                if (busy || !current) return;
                void end().then((done) => {
                  // Refused, the item stays: back to where the person was.
                  if (!done) requestAnimationFrame(() => confirmButton.current?.focus());
                });
              }}
            >
              {busy ? 'Ending…' : 'End it'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                // Back to End, or where End was, while the list couldn't load.
                requestAnimationFrame(() => (endButton.current ?? placeLine.current)?.focus());
              }}
            >
              Keep it
            </Button>
          </>
        ) : (
          <>
            {copy.state === 'live' && canOpen && (
              <Button asChild size="sm" variant="secondary">
                <Link
                  aria-label={`Open it there, in ${where}`}
                  to="/s/$spaceId/p/$pageId"
                  params={{ spaceId: published.spaceId, pageId: copy.pageId }}
                  onClick={onOpenCopy}
                >
                  Open it there
                </Link>
              </Button>
            )}
            {canEnd && (
              <Button
                ref={endButton}
                size="sm"
                variant="outline"
                aria-label={`End this copy in ${where}…`}
                onClick={() => setConfirming(true)}
              >
                End this copy…
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
