import { groupOperations, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { sendGroupChange } from '../commands/sharing-commands';
import { refreshAccess, treeQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { PersonRow } from './access-panel';
import { ChangeReview, GrantConfirm } from './groups';
import { needsKeyReview, useKeyReview } from './key-change';
import { ACCESS_LABELS, accessOf } from './model';
import { shareNameById } from './names';
import { useOwnerRequirements } from './owner-standing';
import { describePerson, peopleQuery, type Person } from './people';
import { HoldOpen, useHoldOpen } from './use-action';

/**
 * Give access (protocol section 7.9): the people waiting for keys in a
 * space the owner owns, by label, with the folders each waits for and the
 * access they would get. Someone whose key changed has it checked first.
 * Each person's keys are sealed only once the owner confirms what they get.
 */
export function GiveAccessDialog({
  spaceId,
  spaceName,
  waiting,
  open,
  onClose,
}: {
  spaceId: SpaceId;
  spaceName: string;
  /** Who waits in this space, as `loadWaiting` lists them now. */
  waiting: readonly groupOperations.Waiting[];
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: tree } = useQuery({ ...treeQuery(ctx, spaceId), enabled: open });
  const { data: people } = useQuery({
    ...peopleQuery(
      ctx,
      waiting.map((w) => w.person.identity.id),
    ),
    enabled: open,
  });
  const { panel, review, labels } = useKeyReview(open);
  const { locked, hold } = useHoldOpen();
  const [giving, setGiving] = useState<Person | null>(null);
  const [done, setDone] = useState<ReactNode>(null);
  const person = (w: groupOperations.Waiting) =>
    people?.get(w.person.identity.id) ?? describePerson(ctx, w.person.identity.id, w.person);

  const give = (who: Person) => {
    const { entry } = who;
    if (!entry) return null;
    return (
      <GrantConfirm
        title={
          <>
            Give <Name>{who.name}</Name> their keys?
          </>
        }
        confirmLabel="Give access"
        make={() => groupOperations.planGiveAccess(ctx, { spaceId, person: entry })}
        review={(change) => (
          <ChangeReview
            spaceId={spaceId}
            change={change}
            shareIds={change.seals.flatMap((s) => s.shares.map((h) => h.shareId))}
            personIds={[who.id]}
          />
        )}
        apply={(change) => sendGroupChange(change, { satisfies, ctx })}
        onCancel={() => setGiving(null)}
        onDone={async () => {
          setGiving(null);
          setDone(
            <>
              <Name>{who.name}</Name> has their keys now.
            </>,
          );
          await refreshAccess(queryClient, ctx);
        }}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent dialogClassName="sm:max-w-xl" {...labels} locked={locked}>
        <HoldOpen value={hold}>
          {panel}
          <div className="grid gap-4" hidden={panel !== null}>
            <DialogHeader>
              <DialogTitle>Give access</DialogTitle>
              <DialogDescription>
                In <Name>{spaceName}</Name>, these people have access through a group or a share,
                but no owner’s app has sealed the keys to them yet. Until then they can’t open those
                folders.
              </DialogDescription>
            </DialogHeader>
            {giving ? (
              give(giving)
            ) : (
              <>
                {done && (
                  <p role="status" className="text-sm font-bold">
                    {done}
                  </p>
                )}
                {waiting.length === 0 && (
                  <p className="text-sm text-muted-foreground">No one is waiting here now.</p>
                )}
                <ul className="grid gap-3">
                  {waiting.map((w) => {
                    const who = person(w);
                    const keyChanged = w.keyChanged || needsKeyReview(who);
                    return (
                      <PersonRow
                        key={who.id}
                        person={who}
                        detail={w.shares.map((share) => (
                          <span key={share.shareId} className="block">
                            <Name>{shareNameById(tree, share.shareId)}</Name>:{' '}
                            {ACCESS_LABELS[accessOf(share)]}
                            {share.holds?.role === 'reader' && share.role === 'editor'
                              ? ', has the reader’s keys'
                              : ''}
                          </span>
                        ))}
                      >
                        {keyChanged ? (
                          <Button
                            size="xs"
                            variant="outline"
                            className="text-destructive"
                            onClick={() =>
                              void review(who).then(() => refreshAccess(queryClient, ctx))
                            }
                          >
                            <ShieldAlert strokeWidth={1.75} /> Key changed
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => {
                              setDone(null);
                              setGiving(who);
                            }}
                          >
                            Give access
                          </Button>
                        )}
                      </PersonRow>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}
