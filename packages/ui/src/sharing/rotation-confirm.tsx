import { useEffect, useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import type { KeyOutcome } from './key-change';
import { isStale } from './messages';
import type { Person } from './people';
import { RotationReview, type LabelledPlan } from './rotation-review';
import { ErrorLine, useAction } from './use-action';

/**
 * Confirm a key rotation, or several (protocol section 7.5): `make` works
 * them out, the owner looks over who keeps each share, and `apply` sends
 * them. If someone else changed access first, they are worked out again
 * and shown again, never sent unseen. Confirming a changed key from here
 * works them out again too. With nothing to rotate, `none` says why, and
 * the owner can confirm only if `confirmNone` (an owner's removal still
 * has to be sent, for one). `summary` shows more of what was worked out,
 * such as what someone keeps through a group.
 */
export function RotationConfirm<T>({
  title,
  intro,
  confirmLabel,
  cancelLabel = 'Cancel',
  none,
  confirmNone = false,
  make,
  plansOf,
  summary,
  apply,
  ownerIds,
  review,
  onCancel,
  onDone,
}: {
  title: ReactNode;
  intro?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  none: ReactNode;
  confirmNone?: boolean;
  make: () => Promise<T>;
  plansOf: (made: T) => LabelledPlan[];
  summary?: (made: T) => ReactNode;
  apply: (made: T) => Promise<void>;
  ownerIds: ReadonlySet<string>;
  review: (person: Person) => Promise<KeyOutcome>;
  onCancel: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [made, setMade] = useState<{ value: T } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { busy, error, run } = useAction();
  const remake = (next: string | null) =>
    run(async () => {
      setMade({ value: await make() });
      setNotice(next);
    });
  // Worked out once when shown; later only on request.
  useEffect(() => {
    void remake(null);
  }, []);

  const confirm = (current: T) =>
    run(async () => {
      setSending(true);
      try {
        await apply(current);
      } catch (caught) {
        if (!isStale(caught)) throw caught;
        setMade({ value: await make() });
        setNotice('Access changed meanwhile. Check who keeps it now, then confirm again.');
        return;
      } finally {
        setSending(false);
      }
      await onDone();
    });

  const plans = made ? plansOf(made.value) : [];
  return (
    <div className="grid gap-4">
      <h3 className="font-extrabold">{title}</h3>
      {intro}
      {notice && (
        <p role="status" className="text-sm font-bold">
          {notice}
        </p>
      )}
      {!made && !error && (
        <p className="text-sm text-muted-foreground">Working out who keeps access…</p>
      )}
      {made && summary?.(made.value)}
      {made && plans.length === 0 && <p className="text-sm text-muted-foreground">{none}</p>}
      {plans.length > 0 && (
        <RotationReview
          plans={plans}
          ownerIds={ownerIds}
          busy={busy}
          onReviewKey={(person) =>
            void review(person).then(
              (outcome) =>
                outcome === 'confirmed' && remake('Key confirmed. Check the list again.'),
            )
          }
        />
      )}
      {sending && (
        <p role="status" className="text-sm font-bold">
          Changing keys… Keep this open until it’s done.
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant="destructive"
          disabled={busy || !made || (plans.length === 0 && !confirmNone)}
          onClick={() => made && void confirm(made.value)}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Why "Remove from every folder" has nothing to do. Only the server says
 * which shares someone is in, so this says so.
 */
export const NotInAnyShare = ({ name }: { name: string }) => (
  <>
    <Name>{name}</Name> isn’t a member of any shared folder here, as far as the server says, so no
    keys change.
  </>
);
