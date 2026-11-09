import type { SpaceId } from '@wikistow/client';
import type { DragEvent } from 'react';
import type { Moving } from '../page/move-dialog';
import { isApple } from './search-model';

// Set, empty, on a drag from a space's sidebar, since Firefox starts no drag without data.
export const NODE_DRAG_TYPE = 'application/x-wikistow-node';

/**
 * A page or folder being dragged from a space's sidebar, for another
 * space's tile in the rail to take (#338). A drag's data can't be read
 * until the drop, so the sidebar keeps what the rail needs here while it
 * lasts. A drop there moves it for an owner of the space (`movesAcross`),
 * and copies it for anyone else, or with Ctrl held (ADR 0007, decision 2;
 * #376). `hints` say why each can't go into another space now, offline
 * for one.
 */
export type DraggedNode = {
  spaceId: SpaceId;
  moving: Moving;
  movesAcross: boolean;
  hints: { move: string | null; copy: string | null };
};

let dragged: DraggedNode | null = null;

export const nodeDrag = {
  get: () => dragged,
  set: (next: DraggedNode | null) => {
    dragged = next;
  },
};

/** Whether a drag copies: Ctrl held, or Option on a Mac, as Finder does (#376). */
export const copying = (event: DragEvent) => (isApple() ? event.altKey : event.ctrlKey);
