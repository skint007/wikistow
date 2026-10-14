import { sharingOperations, type ShareId, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Name } from '@/components/name';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { rotateShare } from '../commands/sharing-commands';
import { refreshAccess, spaceKeysQuery, treeQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { useKeyReview } from './key-change';
import { shareNameById } from './names';
import { useOwnerRequirements } from './owner-standing';
import { RotationConfirm } from './rotation-confirm';
import { HoldOpen, useHoldOpen } from './use-action';

/**
 * New keys for one share, nobody removed (protocol sections 7.5 and 9.7):
 * for an agent that was revoked, lost its pick, or was made a reader, and
 * still holds the keys. Everyone with access keeps it; agents get the new
 * keys from their own people's apps at their next unlock. `onDone` hears
 * that the keys were rotated, before `onClose`.
 */
export function RotateKeysDialog({
  spaceId,
  shareId,
  onClose,
  onDone,
}: {
  spaceId: SpaceId;
  shareId: ShareId | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const { panel, review, labels } = useKeyReview(shareId !== null);
  const { locked, hold } = useHoldOpen();
  const label = shareId ? shareNameById(tree, shareId) : '';
  return (
    <Dialog open={shareId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent dialogClassName="sm:max-w-xl" {...labels} locked={locked}>
        <HoldOpen value={hold}>
          {panel}
          <div className="grid gap-4" hidden={panel !== null}>
            <DialogHeader>
              <DialogTitle>
                New keys for “<Name>{label}</Name>”
              </DialogTitle>
              <DialogDescription>
                An agent still holds keys to this folder that it shouldn’t keep. With new keys, it
                can’t read anything saved from now on that its access doesn’t allow. What it could
                already read, it keeps.
              </DialogDescription>
            </DialogHeader>
            {shareId && (
              <RotationConfirm
                title="Who keeps access"
                confirmLabel="Rotate keys"
                none="Nothing here needs new keys."
                make={() => sharingOperations.planShareRotation(ctx, { spaceId, shareId })}
                plansOf={(planned) => [{ label, plan: planned.plan }]}
                apply={(planned) => runCommand(rotateShare, { planned }, { satisfies, ctx })}
                ownerIds={new Set(keys?.listed.map((o) => o.identity.id))}
                review={review}
                onCancel={onClose}
                onDone={async () => {
                  await refreshAccess(queryClient, ctx);
                  onDone?.();
                  onClose();
                }}
              />
            )}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}
