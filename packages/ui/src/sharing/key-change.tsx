import { fingerprint } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { confirmKey, declineKey } from '../commands/sharing-commands';
import { requirementsHere } from '../commands/ui-commands';
import { refreshAccess } from '../data/queries';
import { useClient } from '../vault/store';
import type { Person } from './people';
import { ErrorLine, useAction } from './use-action';

/** Whether sharing with `person` waits on the key-change warning. */
export const needsKeyReview = (person: Person) =>
  person.status === 'changed' || person.status === 'declined';

export type KeyOutcome = 'confirmed' | 'declined' | 'cancelled';

/**
 * The key-change warning (protocol section 8.4), shown in place of a
 * dialog's content, so it blocks whatever was about to seal to `person`.
 * Nothing seals to them until the owner confirms their new key here;
 * declining keeps it out for good. "Not now" decides nothing, and the key
 * stays unused. Never shown for a pinned key: a pin never changes silently.
 */
export function KeyChangePanel({
  headingId,
  person,
  onClose,
}: {
  /** The heading's ID, which names the dialog while the warning shows. */
  headingId: string;
  person: Person;
  /** `confirmed` once the new key is pinned; otherwise nothing changed that can be shared with. */
  onClose: (outcome: KeyOutcome) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction();
  const { entry } = person;
  // It replaces what had focus, so it takes focus, and is read out from its heading.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const env = { satisfies: requirementsHere(), ctx };

  const decide = (outcome: 'confirmed' | 'declined') =>
    run(async () => {
      if (!entry) return;
      if (outcome === 'confirmed') await runCommand(confirmKey, { person: entry }, env);
      else await runCommand(declineKey, { identity: entry.identity }, env);
      await refreshAccess(queryClient, ctx);
      onClose(outcome);
    });

  const declined = person.status === 'declined';
  return (
    <section className="grid gap-4" aria-labelledby={headingId}>
      <DialogHeader>
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="flex items-center gap-2 text-lg leading-none font-extrabold outline-none"
        >
          <ShieldAlert className="size-5 text-destructive" strokeWidth={1.75} />
          {declined ? (
            <span>
              You declined <Name>{person.name}</Name>’s key
            </span>
          ) : (
            <span>
              <Name>{person.name}</Name>’s key changed
            </span>
          )}
        </h2>
        <p id={`${headingId}-about`} className="text-sm text-muted-foreground">
          {declined
            ? 'You turned this key down before, so nothing is shared with it.'
            : 'The server now gives a different key than the one this app saw before.'}{' '}
          That happens when someone sets up their vault again, or when someone else is trying to
          read what you share. Ask <Name>{person.name}</Name> by phone or in person whether the new
          fingerprint below is theirs.
        </p>
      </DialogHeader>
      <dl className="grid gap-2 rounded-control bg-muted p-3 text-sm">
        {person.email && (
          <div>
            <dt className="font-bold">Email</dt>
            <dd>
              <Name>{person.email}</Name>
            </dd>
          </div>
        )}
        {person.pinnedKey && !declined && (
          <div>
            <dt className="font-bold">Key you had</dt>
            <dd className="font-mono break-all">{fingerprint(person.pinnedKey)}</dd>
          </div>
        )}
        {entry && (
          <div>
            <dt className="font-bold">New key</dt>
            <dd className="font-mono break-all" data-testid="new-fingerprint">
              {fingerprint(entry.identity)}
            </dd>
          </div>
        )}
      </dl>
      <p className="text-sm text-muted-foreground">
        Until you confirm, nothing is shared with this key.
      </p>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={() => onClose('cancelled')}>
          Not now
        </Button>
        {!declined && (
          <Button variant="outline" disabled={busy} onClick={() => void decide('declined')}>
            Decline new key
          </Button>
        )}
        <Button disabled={busy} onClick={() => void decide('confirmed')}>
          Confirm new key
        </Button>
      </DialogFooter>
    </section>
  );
}

/**
 * Ask about a key change from inside a dialog: `review(person)` shows the
 * warning in place of the dialog's content (`panel`), and resolves with
 * what the owner decided. Closing the dialog (`open` false) decides nothing.
 * While it shows, `labels` names and describes the dialog by the warning;
 * when it closes, focus goes back where it was.
 */
export function useKeyReview(open: boolean) {
  const [pending, setPending] = useState<{
    person: Person;
    resolve: (outcome: KeyOutcome) => void;
  } | null>(null);
  // Shown inside another dialog, it mustn't take that dialog's title's ID.
  const headingId = useId();
  const returnTo = useRef<{ element: HTMLElement; dialog: HTMLDialogElement | null } | null>(null);
  const review = useCallback(
    (person: Person) =>
      new Promise<KeyOutcome>((resolve) => {
        const active = document.activeElement;
        returnTo.current =
          active instanceof HTMLElement
            ? { element: active, dialog: active.closest('dialog') }
            : null;
        setPending({ person, resolve });
      }),
    [],
  );
  useEffect(() => {
    if (open || !pending) return;
    pending.resolve('cancelled');
    setPending(null);
  }, [open, pending]);
  // Once the dialog's content shows again: back to what had focus, or, if
  // that went away meanwhile, the first control there.
  useEffect(() => {
    const back = returnTo.current;
    if (pending || !back) return;
    returnTo.current = null;
    const { element, dialog } = back;
    if (element.isConnected && element.checkVisibility()) element.focus();
    else dialog?.querySelector<HTMLElement>('input, select, button:not(:disabled)')?.focus();
  }, [pending]);
  const panel = pending && (
    <KeyChangePanel
      headingId={headingId}
      person={pending.person}
      onClose={(outcome) => {
        setPending(null);
        pending.resolve(outcome);
      }}
    />
  );
  const labels = pending
    ? { labelledBy: headingId, describedBy: `${headingId}-about` }
    : { labelledBy: undefined, describedBy: undefined };
  return { panel, review, labels };
}
