import type { SpaceId } from '@wikistow/client';
import { createContext, useState, type ReactNode } from 'react';
import { SpaceMoveDialog, type MovingSpace } from '../page/move-dialog';
import { OwnerDialog, type OwnerAction } from '../sharing/owner-dialog';

/** Opens the dialog that moves or copies everything in a space (`SpaceMoves`). */
export const SpaceMoveOpener = createContext<(moving: MovingSpace) => void>(() => {});

/**
 * Moving or copying everything in a space (#339), and deleting it once it
 * is empty. The app shell holds them, not the space's header, which a
 * phone's drawer closes as the address changes, and which goes with its
 * space when an old address of what moved leads to the other one. `onOpen`
 * closes the drawer the menu was in. Shown while the vault is open.
 */
export function SpaceMoves({
  unlocked,
  onOpen,
  children,
}: {
  unlocked: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const [moving, setMoving] = useState<MovingSpace | null>(null);
  const [owner, setOwner] = useState<{ spaceId: SpaceId; action: OwnerAction } | null>(null);
  const open = (next: MovingSpace) => {
    onOpen();
    setMoving(next);
  };
  return (
    <SpaceMoveOpener value={open}>
      {children}
      {unlocked && (
        <SpaceMoveDialog
          moving={moving}
          onOpenChange={(isOpen) => !isOpen && setMoving(null)}
          onDeleteSpace={(spaceId) => setOwner({ spaceId, action: { kind: 'delete' } })}
        />
      )}
      {unlocked && owner && (
        <OwnerDialog
          spaceId={owner.spaceId}
          action={owner.action}
          onAction={(action) => setOwner({ spaceId: owner.spaceId, action })}
          onClose={() => setOwner(null)}
        />
      )}
    </SpaceMoveOpener>
  );
}
