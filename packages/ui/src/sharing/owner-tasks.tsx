import { ownerOperations, type IdentityId, type SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { spaceKeysQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { peopleQuery } from './people';

/**
 * Ownership work this app has started and must finish (protocol section
 * 7.6): an owner removal that didn't go through, which blocks every other
 * owner action here until it does, and the key renewal a new owner owes
 * after a transfer. Each opens a dialog that shows who keeps access first.
 */
export function OwnerTasks({
  spaceId,
  onRetryRemoval,
  onRenew,
}: {
  spaceId: SpaceId;
  onRetryRemoval: (ownerId: IdentityId) => void;
  onRenew: (previousOwner: IdentityId) => void;
}) {
  const ctx = useClient();
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const removing = keys ? ownerOperations.removalPending(ctx, keys) : [];
  const handedBy = keys ? ownerOperations.transferPending(ctx, keys) : null;
  const ids = [...removing.map((o) => o.id), ...(handedBy ? [handedBy.id] : [])];
  const { data: people } = useQuery({ ...peopleQuery(ctx, ids), enabled: ids.length > 0 });
  const name = (id: string) => people?.get(id)?.name ?? 'An owner';

  return (
    <>
      {removing.map((owner) => (
        <div
          key={owner.id}
          role="alert"
          className="grid gap-2 rounded-control bg-status-draft p-3 text-sm text-status-draft-foreground"
        >
          <p className="flex items-center gap-2 font-bold">
            <TriangleAlert className="size-4" strokeWidth={1.75} />
            Removing <Name>{name(owner.id)}</Name> as an owner hasn’t finished.
          </p>
          <p>Other owner actions in this space wait until it does.</p>
          <div>
            <Button size="sm" onClick={() => onRetryRemoval(owner.id)}>
              Finish removing
            </Button>
          </div>
        </div>
      ))}
      {handedBy && (
        <div
          role="alert"
          className="grid gap-2 rounded-control bg-status-draft p-3 text-sm text-status-draft-foreground"
        >
          <p className="flex items-center gap-2 font-bold">
            <TriangleAlert className="size-4" strokeWidth={1.75} />
            <Name>{name(handedBy.id)}</Name> handed this space to you.
          </p>
          <p>
            They still know the keys of its shared folders. Renew them, so they can’t read what’s
            saved from now on.
          </p>
          <div>
            <Button size="sm" onClick={() => onRenew(handedBy.id)}>
              Renew keys
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
