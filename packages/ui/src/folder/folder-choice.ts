import type { FolderId, SpaceId } from '@wikistow/client';
import { z } from 'zod';
import { deviceStore } from '../shell/device-store';
import { NO_CHOICE, type FolderChoice } from './folder-model';

const Choice = z.object({
  layout: z.enum(['list', 'table']).nullable().catch(null),
  hidden: z.array(z.string()).catch([]),
});

const useKept = deviceStore<FolderChoice>('wikistow.folder-view.', Choice, NO_CHOICE);

/**
 * A folder's layout and hidden columns, kept on the device (`deviceStore`)
 * per server, account, space and folder, as its open state in the tree is.
 */
export const useFolderChoice = (spaceId: SpaceId, folderId: FolderId) => useKept(spaceId, folderId);
