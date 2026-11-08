import type { SpaceId } from '@wikistow/client';
import { createContext, useState, type ReactNode } from 'react';
import { MoveDialog, SpaceMoveDialog, type Moving, type MovingSpace } from '../page/move-dialog';
import { OwnerDialog, type OwnerAction } from '../sharing/owner-dialog';

/** Opens the dialog that moves or copies everything in a space (`SpaceMoves`). */
export const SpaceMoveOpener = createContext<(moving: MovingSpace) => void>(() => {});

/**
 * Opens Move to… or Copy to… for a page or folder of `spaceId` dropped on
 * another space's tile in the rail (#338), held by `SpaceMoves` too.
 */
export const DropMoveOpener = createContext<(spaceId: SpaceId, moving: Moving) => void>(() => {});

/**
 * Moving or copying everything in a space (#339), and deleting it once it
 * is empty, and a page or folder dropped on a space in the rail (#338).
 * The app shell holds them, not the space's header or sidebar, which a
 * phone's drawer closes as the address changes, and which go with their
 * space when an old address of what moved leads to the other one. `onOpen`
 * closes the drawer the menu or rail was in. Shown while the vault is open.
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
  // Its space stays while the dialog closes.
  const [dropped, setDropped] = useState<{ spaceId: SpaceId; moving: Moving | null } | null>(null);
  const open = (next: MovingSpace) => {
    onOpen();
    setMoving(next);
  };
  const openDropped = (spaceId: SpaceId, next: Moving) => {
    onOpen();
    setDropped({ spaceId, moving: next });
  };
  return (
    <SpaceMoveOpener value={open}>
      <DropMoveOpener value={openDropped}>{children}</DropMoveOpener>
      {unlocked && dropped && (
        <MoveDialog
          spaceId={dropped.spaceId}
          moving={dropped.moving}
          onOpenChange={(isOpen) => !isOpen && setDropped({ ...dropped, moving: null })}
        />
      )}
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
