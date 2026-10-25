import type { ClientContext, searchOperations } from '@wikistow/client';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { searchIndexQuery, searchProgressKey } from './queries';

/** The search index as a component sees it (`usePageIndex`). */
export type PageIndexState = {
  /** The latest index built, kept while a newer one builds; undefined before the first. */
  index: searchOperations.PageIndex | undefined;
  /** How far the index being built has got. */
  progress: searchOperations.IndexProgress | undefined;
  /** Why the last build failed, or null. `index` may still hold an older one. */
  error: Error | null;
  /** A newer index is being built behind `index`. */
  updating: boolean;
  /** Build it again, after an error. */
  retry: () => void;
};

/**
 * The pages this person can open, as their search index holds them, each
 * in the version they see: titles, text and properties (`PageIndex`), for
 * search and for whatever lists pages by their properties.
 *
 * One index serves every caller. While a component uses this (and
 * `enabled`), the index is built if it isn't, and built again after a
 * change to a page, this person's own or one the server tells of
 * (`searchIndexChanged`), or once a minute old when the component mounts
 * or the window is focused. Each build is a new `index` object, so derive
 * from it with `useMemo([index])`, and a component shows changes as they
 * come. Building reads every space's tree, and opens each page whose
 * version changed, so leave it disabled until it is needed: for instance
 * until a menu that suggests keys opens.
 */
export function usePageIndex(
  ctx: ClientContext,
  { enabled = true }: { enabled?: boolean } = {},
): PageIndexState {
  const queryClient = useQueryClient();
  const query = useQuery({ ...searchIndexQuery(ctx, queryClient), enabled });
  const { data: progress } = useQuery<searchOperations.IndexProgress>({
    queryKey: searchProgressKey,
    queryFn: skipToken,
  });
  return {
    index: query.data,
    progress,
    error: query.error,
    updating: query.isFetching,
    retry: () => void query.refetch(),
  };
}
