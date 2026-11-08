import {
  folderIconOf,
  ICON_MEDIA_TYPES,
  ICON_NAMESPACE,
  type ClientContext,
  type IconMediaType,
  type PageId,
  type pageOperations,
  type SpaceId,
  type spaceOperations,
} from '@wikistow/client';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { treeQuery } from '../../data/queries';
import { PLAIN, useClient, vaultStore } from '../../vault/store';
import { decryptedQuery } from '../attachments';
import { iconFile, type IconFile } from './icon-image';

/**
 * The query for a `blob:` URL of a folder's or space's image, or null for
 * none. Made once for each version of its metadata, not on each tree load,
 * and kept until the vault locks. It needs no network: the image came with
 * the metadata.
 */
export const folderIconQuery = (loaded: spaceOperations.LoadedMetadata | null | undefined) => {
  const metadata = loaded?.opened.kind === 'current' ? loaded.opened.metadata : null;
  return queryOptions({
    // A version's metadata never changes, so its ID is enough.
    queryKey: [PLAIN, 'folder-icon', loaded?.head],
    enabled: metadata?.extensions[ICON_NAMESPACE] != null,
    staleTime: Infinity,
    gcTime: Infinity,
    networkMode: 'always',
    retry: false,
    queryFn: () => {
      const icon = metadata && folderIconOf(metadata);
      return icon ? vaultStore.objectUrl(icon.bytes, icon.mediaType, vaultStore.epoch()) : null;
    },
  });
};

/** An image already in the space, to use again: shown from `url`, kept as `icon`. */
export type SpaceImage = { url: string; name: string | null; icon: IconFile };

/** How many images the picker offers again. */
const MOST = 12;

const iconType = (type: string): type is IconMediaType =>
  ICON_MEDIA_TYPES.some((known) => known === type);

const nameIn = (loaded: spaceOperations.LoadedMetadata | null) =>
  loaded?.opened.kind === 'current' ? loaded.opened.metadata.name : null;

// Images with the same bytes show once.
async function sameBytesKey(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// What of the tree the images come from.
type Tree = {
  space: { metadata: spaceOperations.LoadedMetadata | null } | null;
  folders: readonly { metadata: spaceOperations.LoadedMetadata | null }[];
  pages: readonly { id: PageId; title: string | null; icon: pageOperations.PageIcon | null }[];
};

async function spaceImages(
  ctx: ClientContext,
  queryClient: QueryClient,
  spaceId: SpaceId,
  tree: Tree,
  current: string | null,
): Promise<SpaceImage[]> {
  // Each image found, with a folder's URL made only when its turn comes.
  const found: (() => Promise<SpaceImage | null>)[] = [];
  for (const { metadata } of [...(tree.space ? [tree.space] : []), ...tree.folders]) {
    const opened = metadata?.opened.kind === 'current' ? metadata.opened.metadata : null;
    const icon = opened && folderIconOf(opened);
    if (!icon) continue;
    found.push(async () => {
      const url = await queryClient.fetchQuery(folderIconQuery(metadata));
      return url
        ? { url, name: nameIn(metadata), icon: iconFile(icon.mediaType, icon.bytes) }
        : null;
    });
  }
  for (const page of tree.pages) {
    if (!page.icon) continue;
    const { ref, audience } = page.icon;
    const { mediaType } = ref;
    if (!iconType(mediaType)) continue;
    // Only what the sidebar already decrypted: nothing is downloaded for this.
    const url = queryClient.getQueryData(
      decryptedQuery({ ctx, page: { spaceId, pageId: page.id }, audience }, ref).queryKey,
    );
    const blob = url && vaultStore.blobOf(url);
    if (!url || !blob) continue;
    found.push(async () => ({
      url,
      name: page.title,
      icon: iconFile(mediaType, new Uint8Array(await blob.arrayBuffer())),
    }));
  }

  const inUse = current && vaultStore.blobOf(current);
  const seen = new Set(
    inUse ? [await sameBytesKey(new Uint8Array(await inUse.arrayBuffer()))] : [],
  );
  const images: SpaceImage[] = [];
  for (const find of found) {
    if (images.length === MOST) break;
    const image = await find();
    if (!image) continue;
    const key = await sameBytesKey(image.icon.bytes);
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(image);
  }
  return images;
}

/**
 * The images of the space, its folders and its pages, to choose again in
 * the picker's Image tab: those this app already holds, in the order of the
 * tree, each image once, and not the one in use (`current`). It downloads
 * nothing: a folder's image came with the tree, and a page's is offered
 * only once its sidebar row has decrypted it.
 */
export function useSpaceImages(spaceId: SpaceId, current: string | null) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  // The tree the sidebar holds, never fetched again for this.
  const { data: tree, dataUpdatedAt } = useQuery({ ...treeQuery(ctx, spaceId), enabled: false });
  return useQuery({
    queryKey: [PLAIN, 'space-images', spaceId, current, dataUpdatedAt],
    enabled: tree !== undefined,
    // Worked out again on each opening, for page images decrypted since.
    gcTime: 0,
    networkMode: 'always',
    retry: false,
    queryFn: () => (tree ? spaceImages(ctx, queryClient, spaceId, tree, current) : []),
  }).data;
}
