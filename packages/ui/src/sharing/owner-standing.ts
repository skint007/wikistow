import type { ClientContext, SpaceId } from '@wikistow/client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { requirementsHere } from '../commands/ui-commands';
import { noAnswer } from '../data/connection';
import { ownerToConfirmQuery, spacesQuery } from '../data/queries';
import { useClient } from '../vault/store';

/**
 * Where this person stands as an owner of a space: `owner`, who may act as
 * one; `unconfirmed`, an owner who hasn't confirmed who added them yet
 * (protocol section 6.5), so takes no owner action; `checking` while that
 * is worked out; null for anyone else. Owner controls show for `owner` only.
 */
export type OwnerStanding = 'owner' | 'unconfirmed' | 'checking' | null;

/**
 * Whether this person may delete in the space: as an owner, or offline
 * while the check waits for the server. A delete made offline waits on this
 * device, and goes to the trash, where an owner can restore it (#330).
 */
export const mayDelete = (standing: OwnerStanding, offline: boolean) =>
  standing === 'owner' || (standing === 'checking' && offline);

/**
 * Whether this person may move things as an owner of the space: as an
 * owner, or offline while the check waits for the server. Offline, a move
 * stays in its share, changing no keys, and waits on this device (#331).
 */
export const movesAsOwner = (standing: OwnerStanding, offline: boolean) =>
  standing === 'owner' || (standing === 'checking' && offline);

export function useOwnerStanding(spaceId: SpaceId): OwnerStanding {
  const ctx = useClient();
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const owner = spaces?.find((s) => s.id === spaceId)?.role === 'owner';
  const adder = useQuery({ ...ownerToConfirmQuery(ctx, spaceId), enabled: owner });
  return owner ? standingFrom(adder) : null;
}

/**
 * An owner's standing from the check for an adder they haven't confirmed.
 * Only a check that came back with nobody to confirm makes them `owner`; a
 * failed one can't show they confirmed, so leaves them `unconfirmed`. One
 * the server gave no answer to, as offline, is still `checking`: owner
 * actions wait for the server anyway (ADR 0009, decision 8), and there is
 * nothing to confirm until it answers.
 */
export function standingFrom(
  adder: Pick<UseQueryResult<unknown>, 'status' | 'data' | 'error'>,
): Exclude<OwnerStanding, null> {
  switch (adder.status) {
    case 'pending':
      return 'checking';
    case 'error':
      return noAnswer(adder.error) ? 'checking' : 'unconfirmed';
    case 'success':
      return adder.data ? 'unconfirmed' : 'owner';
  }
}

/** What a command run in this space satisfies: `space-owner` only for an owner who may act. */
export const useOwnerRequirements = (spaceId: SpaceId) =>
  requirementsHere({ owner: useOwnerStanding(spaceId) === 'owner' });

// Spaces whose confirmation the person put off, per session: asked again
// after the next unlock, or sooner when they ask for it (`askAgain`).
const putOff = new WeakMap<ClientContext, ReadonlySet<SpaceId>>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function setPutOff(ctx: ClientContext, spaceId: SpaceId, later: boolean) {
  const spaces = new Set(putOff.get(ctx));
  if (later) spaces.add(spaceId);
  else spaces.delete(spaceId);
  putOff.set(ctx, spaces);
  for (const listener of listeners) listener();
}

/** Whether the person put off confirming who added them to this space. */
export const usePutOff = (ctx: ClientContext, spaceId: SpaceId): boolean =>
  useSyncExternalStore(subscribe, () => putOff.get(ctx)?.has(spaceId) ?? false);

/** Put the question off until the next unlock. */
export const putOffConfirming = (ctx: ClientContext, spaceId: SpaceId) =>
  setPutOff(ctx, spaceId, true);

/** Ask who added them again now, without locking first. */
export const askAgain = (ctx: ClientContext, spaceId: SpaceId) => setPutOff(ctx, spaceId, false);
