import type { SpaceId } from '@wikistow/client';
import type { Moving } from '../page/move-dialog';

// Set, empty, on a drag from a space's sidebar, since Firefox starts no drag without data.
export const NODE_DRAG_TYPE = 'application/x-wikistow-node';

/**
 * A page or folder being dragged from a space's sidebar, for another
 * space's tile in the rail to take (#338). A drag's data can't be read
 * until the drop, so the sidebar keeps what the rail needs here while it
 * lasts. `action` is what a drop opens: Move to… for an owner of the
 * space, Copy to… for anyone else (ADR 0007, decision 2). `hint` says why
 * it can't go into another space now, offline for one.
 */
export type DraggedNode = {
  spaceId: SpaceId;
  moving: Moving;
  action: 'move' | 'copy';
  hint: string | null;
};

let dragged: DraggedNode | null = null;

export const nodeDrag = {
  get: () => dragged,
  set: (next: DraggedNode | null) => {
    dragged = next;
  },
};
