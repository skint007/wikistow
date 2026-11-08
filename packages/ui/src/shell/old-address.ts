import type { SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { movedQuery } from '../data/queries';
import { useClient } from '../vault/store';

/**
 * An old address of a page or folder a move took into another space opens
 * its new place instead, in the same history entry, for someone who can
 * open it there (protocol section 10, "Old addresses"). Asked once the
 * address finds nothing (`gone`); true while it is asked, and once it has
 * been found, until the new place opens. With `follow` false it only says
 * so, for a view around the page or folder that would otherwise leave.
 */
export function useOldAddress(
  old: { spaceId: SpaceId; nodeId: string | undefined },
  gone: boolean,
  { follow = true } = {},
): boolean {
  const ctx = useClient();
  const navigate = useNavigate();
  const asked = gone && old.nodeId !== undefined;
  // A link to a heading of it goes to that heading there.
  const hash = useLocation({ select: (location) => location.hash });
  const { data: place, isPending } = useQuery({
    ...movedQuery(ctx, { spaceId: old.spaceId, nodeId: old.nodeId ?? '' }),
    enabled: asked,
  });
  useEffect(() => {
    if (!follow || !asked || !place) return;
    // The new place says it moved (`useArrivedMoved`).
    const there = {
      replace: true,
      hash,
      state: <T extends object>(prev: T) => Object.assign({}, prev, { moved: true }),
    };
    void navigate(
      place.kind === 'page'
        ? {
            to: '/s/$spaceId/p/$pageId',
            params: { spaceId: place.spaceId, pageId: place.nodeId },
            ...there,
          }
        : {
            to: '/s/$spaceId/f/$folderId',
            params: { spaceId: place.spaceId, folderId: place.nodeId },
            ...there,
          },
    );
  }, [follow, asked, place, navigate, hash]);
  return asked && (isPending || Boolean(place));
}

/** Whether this page or folder was opened from an old address (`useOldAddress`). */
export const useArrivedMoved = () =>
  useLocation({ select: (location) => 'moved' in location.state && location.state.moved === true });
