import { fingerprint, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { confirmAdder } from '../commands/sharing-commands';
import { requirementsHere } from '../commands/ui-commands';
import { ownerToConfirmQuery, refreshAccess, spacesQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { nameOf } from './names';
import { sharingMessage } from './messages';
import { describePerson, peopleQuery } from './people';
import { putOffConfirming, usePutOff } from './owner-standing';
import { NewMark } from './new-mark';
import { ErrorLine, useAction } from './use-action';

/**
 * A new owner's first look at a space (protocol section 6.5): "<label>
 * added you as an owner of <space>". Confirming accepts the adder, and
 * through them the other owners, and names the adder back. Until then this
 * app takes no owner action here and opens nothing the adder sealed, and
 * the space shows no owner controls. "Not now" puts the question off until
 * the next unlock, or until the person asks for it again (`askAgain`).
 */
export function OwnerConfirm({ spaceId }: { spaceId: SpaceId }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const space = spaces?.find((s) => s.id === spaceId);
  const check = useQuery({
    ...ownerToConfirmQuery(ctx, spaceId),
    enabled: space?.role === 'owner',
  });
  const adder = check.data;
  const { data: people } = useQuery({
    ...peopleQuery(ctx, adder ? [adder.id] : []),
    enabled: !!adder,
  });
  const later = usePutOff(ctx, spaceId);
  const { busy, error, run } = useAction();
  const close = () => putOffConfirming(ctx, spaceId);
  // The space shows no owner controls until this check works out.
  if (check.isError) {
    return (
      <Dialog open={!later} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>This app couldn’t check who made you an owner</DialogTitle>
              <DialogDescription>
                Until it can, you can’t share this space or manage who has access.
              </DialogDescription>
            </DialogHeader>
            <ErrorLine error={sharingMessage(check.error)} />
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Not now
              </Button>
              <Button disabled={check.isFetching} onClick={() => void check.refetch()}>
                Try again
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
  if (!adder) return null;
  const who = people?.get(adder.id) ?? describePerson(ctx, adder.id, null);
  const spaceName = nameOf(space?.metadata);

  return (
    <Dialog open={!later} onOpenChange={(open) => !open && close()}>
      <DialogContent locked={busy}>
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              <Name>{who.name}</Name> added you as an owner of{' '}
              {spaceName ? (
                <>
                  “<Name>{spaceName}</Name>”
                </>
              ) : (
                'a space'
              )}
            </DialogTitle>
            <DialogDescription>
              Confirm only if you expected it. Once you do, this app trusts <Name>{who.name}</Name>{' '}
              and the owners they trust here, and you can share and manage the space.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-2 rounded-control bg-muted p-3 text-sm">
            {who.email && (
              <div>
                <dt className="font-bold">Email</dt>
                <dd>
                  <Name>{who.email}</Name>
                </dd>
              </div>
            )}
            <div>
              <dt className="font-bold">Their key</dt>
              <dd className="font-mono break-all">{fingerprint(adder)}</dd>
            </div>
            <div>
              <dt className="font-bold">In your contacts</dt>
              <dd>
                {who.pinned ? (
                  <>
                    Since{' '}
                    {new Date(who.pinned.at).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {who.pinned.checked
                      ? ', with a key you confirmed.'
                      : ', from the first time this app saw them, unchecked.'}
                  </>
                ) : (
                  <>
                    <NewMark /> This app has never seen them before.
                  </>
                )}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            Not now puts this off. Until you confirm, you can’t share this space or manage who has
            access. You’ll be asked again the next time you unlock, or from the space’s heading.
          </p>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={close}>
              Not now
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await runCommand(
                    confirmAdder,
                    { spaceId, adder },
                    { satisfies: requirementsHere(), ctx },
                  );
                  await refreshAccess(queryClient, ctx);
                })
              }
            >
              Confirm
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
