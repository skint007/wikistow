import type { SpaceId } from '@wikistow/client';
import { z } from 'zod';
import { deviceStore } from './device-store';

const NONE: ReadonlySet<string> = new Set();

const useKept = deviceStore<ReadonlySet<string>>(
  'wikistow.expanded.',
  z.array(z.string()).transform((ids): ReadonlySet<string> => new Set(ids)),
  NONE,
  (set) => [...set],
);

/**
 * The folders open in a space's tree, by ID, so a rename or move keeps them,
 * and a setter taking the current set. Kept on the device (`deviceStore`)
 * per server, account and space. The tree skips IDs it no longer has.
 */
export const useExpandedFolders = (spaceId: SpaceId) => useKept(spaceId);
