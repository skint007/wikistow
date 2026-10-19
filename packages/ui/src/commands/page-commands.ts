import {
  FolderId,
  moveOperations,
  pageOperations,
  publicationOperations,
  PageId,
  RevisionId,
  SpaceId,
  type ClientContext,
  type sharingOperations,
} from '@wikistow/client';
import { z } from 'zod';
import type { Command, CommandEnv } from './command';

/** Where a page command runs: the open session, and who hears how a long one is getting on. */
export type PageEnv = CommandEnv & {
  ctx: ClientContext;
  onProgress?: sharingOperations.Progress;
};

// A preview from the client's own operation, which already checked it.
const Preview = z.custom<moveOperations.MovePreview>(
  (value) => typeof value === 'object' && value !== null && 'nodeId' in value,
);

/**
 * Move a page or folder as previewed, once the person confirms it, or at
 * once if they turned asking before moves off. Who may is the server's to
 * enforce: an editor within their share, an owner anywhere in the space.
 */
export const moveNode: Command<z.ZodObject<{ preview: typeof Preview }>, PageEnv> = {
  id: 'node.move',
  input: z.object({ preview: Preview }),
  requires: ['unlocked-vault'],
  run: async ({ preview }, { ctx, onProgress }) =>
    moveOperations.moveNode(ctx, { preview, ...(onProgress ? { onProgress } : {}) }),
};

const PageRefInput = z.object({ spaceId: SpaceId, pageId: PageId });

const CreatePage = z.object({
  spaceId: SpaceId,
  parentId: FolderId.nullable(),
  title: z.string().trim().min(1),
});

/**
 * Create a page with that title, as a private draft at the space root or in
 * a folder, then hand it to `onCreated` (to open it, say). The server checks
 * the person may write there.
 */
export const createPage: Command<
  typeof CreatePage,
  PageEnv & { onCreated: (pageId: PageId) => Promise<void> }
> = {
  id: 'page.create',
  input: CreatePage,
  requires: ['unlocked-vault'],
  run: async (input, { ctx, onCreated }) => onCreated(await pageOperations.createPage(ctx, input)),
};

const Unpublish = z.object({
  spaceId: SpaceId,
  pageId: PageId,
  publishedHead: RevisionId,
  permissionVersion: z.number().int(),
});

/** Hide a page from readers, if its publication and access are still what the person saw. */
export const unpublishPage: Command<typeof Unpublish, PageEnv> = {
  id: 'page.unpublish',
  input: Unpublish,
  requires: ['unlocked-vault', 'page-editor'],
  run: async ({ spaceId, pageId, ...seen }, { ctx }) =>
    pageOperations.unpublishPage(ctx, { spaceId, pageId }, seen),
};

// A publication preview from the client's own operation, which opened and checked the source.
const PublicationPreview = z.custom<publicationOperations.PublicationPreview>(
  (value) => typeof value === 'object' && value !== null && 'destination' in value,
);

/**
 * Publish the version a person is looking at into another space, with the
 * attachments they picked, once they confirmed the preview. Only someone
 * who can publish the page may, which the server enforces (section 13).
 */
export const publishElsewhere: Command<
  z.ZodObject<{ preview: typeof PublicationPreview; attachmentIds: z.ZodArray<z.ZodString> }>,
  PageEnv
> = {
  id: 'page.publish-elsewhere',
  input: z.object({ preview: PublicationPreview, attachmentIds: z.array(z.string()) }),
  requires: ['unlocked-vault'],
  run: async ({ preview, attachmentIds }, { ctx }) => {
    await publicationOperations.publishToSpace(ctx, {
      preview,
      attachmentIds: new Set(attachmentIds),
    });
  },
};

const EndPublication = z.object({ source: PageRefInput, spaceId: SpaceId });

/**
 * End a page's publication in another space, wherever its copy is there,
 * so this page no longer updates it, and publishing there makes a new page.
 * The copy stays there as a page of its own. `onEnded` hears whether there
 * was one to end.
 */
export const endPublication: Command<
  typeof EndPublication,
  PageEnv & { onEnded?: (ended: boolean) => void }
> = {
  id: 'page.end-publication',
  input: EndPublication,
  requires: ['unlocked-vault'],
  run: async (input, { ctx, onEnded }) => {
    const ended = await publicationOperations.endPublication(ctx, input);
    onEnded?.(ended);
  },
};

/** Make a page published from another page a page of its own, to edit here. */
export const detachPage: Command<typeof PageRefInput, PageEnv> = {
  id: 'page.detach',
  input: PageRefInput,
  requires: ['unlocked-vault', 'page-editor'],
  run: async (page, { ctx }) => {
    await publicationOperations.detachPublication(ctx, page);
  },
};
