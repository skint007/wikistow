import type { IdentityId, ShareId, SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { revokeAgent } from '../commands/agent-commands';
import { requirementsHere } from '../commands/ui-commands';
import { refreshAccess, treeQuery } from '../data/queries';
import { shareNameById } from '../sharing/names';
import { useOwnerStanding } from '../sharing/owner-standing';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { agentMessage } from './messages';

type ShareRef = { spaceId: SpaceId; shareId: ShareId };

/**
 * Revoke an agent (protocol section 9.7), saying what it means first: its
 * token ends now, but keys it already holds stay with it. Afterwards, each
 * share it could read is listed: one in a space this person owns can get
 * new keys at once (`onRotate`); the owners of any other are offered it.
 */
export function RevokeDialog({
  agent,
  paused = false,
  rotated,
  onClose,
  onRotate,
}: {
  agent: { agentId: IdentityId; name: string; shares: readonly ShareRef[] } | null;
  /** Hidden for now, keeping where it was, while a share gets new keys. */
  paused?: boolean;
  /** Shares given new keys since it opened. */
  rotated: ReadonlySet<string>;
  onClose: () => void;
  onRotate: (share: ShareRef) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { locked, hold } = useHoldOpen();
  const [revoked, setRevoked] = useState(false);
  const close = () => {
    setRevoked(false);
    onClose();
  };
  return (
    <Dialog
      open={agent !== null && !paused}
      // Pausing closes the native dialog too, which isn't the person closing it.
      onOpenChange={(open) => !open && !paused && close()}
    >
      <DialogContent dialogClassName="sm:max-w-lg" locked={locked}>
        <HoldOpen value={hold}>
          {agent && (
            <RevokeBody
              agent={agent}
              revoked={revoked}
              onRevoke={async () => {
                await runCommand(
                  revokeAgent,
                  { agentId: agent.agentId },
                  { satisfies: requirementsHere(), ctx },
                );
                setRevoked(true);
                await refreshAccess(queryClient, ctx);
              }}
              rotated={rotated}
              onClose={close}
              onRotate={onRotate}
            />
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

function RevokeBody({
  agent,
  revoked,
  rotated,
  onRevoke,
  onClose,
  onRotate,
}: {
  agent: { name: string; shares: readonly ShareRef[] };
  revoked: boolean;
  rotated: ReadonlySet<string>;
  onRevoke: () => Promise<void>;
  onClose: () => void;
  onRotate: (share: ShareRef) => void;
}) {
  const { busy, error, run } = useAction(agentMessage);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {revoked ? (
            <>
              <Name>{agent.name}</Name> is revoked
            </>
          ) : (
            <>
              Revoke <Name>{agent.name}</Name>?
            </>
          )}
        </DialogTitle>
        <DialogDescription>
          {revoked
            ? 'Its credential no longer works, and your apps won’t give it keys again.'
            : 'Its credential stops working at once: from its next request, it can’t read, save or publish anything here. This can’t be undone; to use that computer again, enroll a new agent.'}
        </DialogDescription>
      </DialogHeader>
      {agent.shares.length > 0 && (
        <section aria-label="Folders it could read" className="grid gap-2 text-sm">
          <p>
            It keeps the keys it already has, so whatever it could read until now may still be on
            that computer.{' '}
            {revoked
              ? 'New keys for these folders keep it out of anything saved from now on:'
              : 'Afterwards, you can give these folders new keys, so it can’t read anything saved from then on:'}
          </p>
          <ul className="grid gap-1">
            {agent.shares.map((share) => (
              <ShareRow
                key={share.shareId}
                share={share}
                revoked={revoked}
                rotated={rotated.has(share.shareId)}
                onRotate={() => onRotate(share)}
              />
            ))}
          </ul>
        </section>
      )}
      <ErrorLine error={error} />
      {busy && (
        <p role="status" className="text-sm font-bold">
          Revoking…
        </p>
      )}
      <DialogFooter>
        {revoked ? (
          <Button autoFocus onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void run(onRevoke)}>
              Revoke
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

/** A share the agent could read: rotate it here if this person may, else its owners will be asked. */
function ShareRow({
  share,
  revoked,
  rotated,
  onRotate,
}: {
  share: ShareRef;
  revoked: boolean;
  rotated: boolean;
  onRotate: () => void;
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, share.spaceId));
  const standing = useOwnerStanding(share.spaceId);
  const note = (text: string) => <span className="text-xs text-muted-foreground">{text}</span>;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-row bg-muted px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate font-bold">
        <Name>{shareNameById(tree, share.shareId)}</Name>
      </span>
      {rotated
        ? note('New keys made')
        : standing === 'owner'
          ? revoked && (
              <Button size="xs" variant="outline" onClick={onRotate}>
                Rotate keys
              </Button>
            )
          : standing === 'unconfirmed'
            ? note('Confirm your ownership of this space, then rotate its keys')
            : standing === 'checking'
              ? null
              : note('Its owners will be offered new keys')}
    </li>
  );
}
