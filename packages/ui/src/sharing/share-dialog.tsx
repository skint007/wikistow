import type { FolderId, SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { sharesQuery, spaceKeysQuery, treeQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { AccessPanel } from './access-panel';
import { FirstShare } from './first-share';
import { useKeyReview } from './key-change';
import { sharingMessage } from './messages';
import { shareTarget } from './model';
import { shareName } from './names';
import { HoldOpen, useHoldOpen } from './use-action';

/**
 * The Share dialog for a folder, or the whole space for a null root: share
 * it the first time, or see and change who has access. Opened from the
 * page's Share button, the folder menu and the space menu, by owners only.
 * A folder inside a share points to that share instead: shares don't nest.
 */
export function ShareDialog({
  spaceId,
  rootId,
  open,
  onOpenChange,
}: {
  spaceId: SpaceId;
  rootId: FolderId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ctx = useClient();
  // The folder shown: a folder inside a share switches to that share.
  const [shown, setShown] = useState(rootId);
  useEffect(() => {
    if (open) setShown(rootId);
  }, [open, rootId]);
  const tree = useQuery({ ...treeQuery(ctx, spaceId), enabled: open });
  const shares = useQuery({ ...sharesQuery(ctx, spaceId), enabled: open });
  const keys = useQuery({ ...spaceKeysQuery(ctx, spaceId), enabled: open });
  const { panel, review, labels } = useKeyReview(open);
  const { locked, hold } = useHoldOpen();

  const failed = tree.error ?? shares.error ?? keys.error;
  const owners = keys.data?.listed.map((owner) => owner.identity.id) ?? [];
  const target =
    tree.data && shares.data
      ? shareTarget({ shares: shares.data, folders: tree.data.folders }, shown)
      : null;
  const name = shareName(tree.data, shown);

  const body = () => {
    if (failed) {
      return (
        <p role="alert" className="text-sm text-destructive">
          {sharingMessage(failed)}
        </p>
      );
    }
    if (!target || !keys.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
    switch (target.kind) {
      case 'new':
        return (
          <FirstShare spaceId={spaceId} rootId={shown} ownerIds={new Set(owners)} review={review} />
        );
      case 'shared':
        return (
          <AccessPanel spaceId={spaceId} share={target.share} owners={owners} review={review} />
        );
      case 'inside':
      case 'holds': {
        const other = shareName(tree.data, target.share.rootId);
        // How many shares sit inside the space or folder that can't be shared.
        const held =
          target.kind === 'holds' && tree.data && shares.data
            ? shares.data.filter(
                (share) =>
                  shown === null ||
                  shareTarget({ shares: [share], folders: tree.data.folders }, shown).kind ===
                    'holds',
              ).length
            : 0;
        return (
          <div className="grid gap-3">
            <p className="text-sm">
              {target.kind === 'inside' ? (
                target.share.rootId === null ? (
                  <>
                    The whole space is shared, so “<Name>{name}</Name>” is shared with everyone in
                    it.
                  </>
                ) : (
                  <>
                    “<Name>{name}</Name>” is inside “<Name>{other}</Name>”, which is shared, so it’s
                    shared with everyone there.
                  </>
                )
              ) : held > 1 ? (
                <>
                  {held} folders inside “<Name>{name}</Name>” are shared already, “
                  <Name>{other}</Name>” among them.
                </>
              ) : (
                <>
                  “<Name>{other}</Name>”, inside “<Name>{name}</Name>”, is shared already.
                </>
              )}{' '}
              {target.kind === 'inside'
                ? 'Shares don’t nest, so it’s shared only through that one.'
                : shown === null
                  ? 'Shares don’t nest, so the whole space can’t be shared as well.'
                  : 'Shares don’t nest, so this folder can’t be shared as well.'}
            </p>
            <div>
              <Button variant="secondary" onClick={() => setShown(target.share.rootId)}>
                Manage “<Name>{other}</Name>”
              </Button>
            </div>
          </div>
        );
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" {...labels} locked={locked}>
        <HoldOpen value={hold}>
          {panel}
          {/* Kept mounted under the key-change warning, so what was being done survives it. */}
          <div className="grid gap-4" hidden={panel !== null}>
            <DialogHeader>
              <DialogTitle>
                Share “<Name>{name}</Name>”
              </DialogTitle>
              <DialogDescription>
                {shown === null
                  ? 'Everyone you add gets the whole space: every folder and page in it.'
                  : 'Everyone you add gets this folder and everything in it, never the folders above it.'}
              </DialogDescription>
            </DialogHeader>
            {open && body()}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}
