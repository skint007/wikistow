// Opening a merge (ADR 0013, decision 2): the three versions, merged, and
// whose theirs is. For a draft someone else saved (`stale-head`), and for
// a change made offline that came back as one, whose base is kept on this
// device; or for another window's change waiting on this device.
import {
  pageMerge,
  type AttachmentRef,
  type ClientContext,
  type pageOperations,
  type RevisionId,
} from '@wikistow/client';
import type { QueryClient } from '@tanstack/react-query';
import { revisionQuery } from '../../data/queries';
import { peopleQuery } from '../../sharing/people';
import type { DraftSession, MergedOver } from '../draft-session';
import type { Theirs } from './merge-model';

/** A merge ready to show, and what a save goes on top of. */
export type OpenedMerge = {
  merge: pageMerge.Merge;
  theirs: Theirs;
  /** The version the merge read as theirs. */
  over: MergedOver;
  /** Both sides' attachments, for the pictures a banner or icon overlap shows. */
  attachments: readonly AttachmentRef[];
};

/** Thrown when there is nothing to merge, or theirs can't be read here. */
export class CantMerge extends Error {}

const NOTHING = 'There’s nothing to merge with now.';

/**
 * A merge with the draft someone else saved. The base is the draft the
 * person's text is based on, which the revision cache opens from this
 * device first when it is kept, as an offline change's base is.
 */
export async function openOnlineMerge(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  session: DraftSession,
  queryClient: QueryClient,
): Promise<OpenedMerge> {
  const versions = await session.mergeVersions();
  if (!versions) throw new CantMerge(NOTHING);
  const open = (revisionId: RevisionId) =>
    queryClient.fetchQuery(revisionQuery(ctx, page, 'draft', revisionId));
  const [base, theirs] = await Promise.all([open(versions.base), open(versions.theirs)]);
  if (base.opened.kind !== 'current' || theirs.opened.kind !== 'current')
    throw new CantMerge(
      'The other version was written by a newer version of WikiStow. Update to merge it.',
    );
  return {
    merge: pageMerge.mergePayloads(base.opened.payload, versions.yours, theirs.opened.payload),
    theirs: await whoseIs(ctx, queryClient, theirs.record.authorId),
    over: { kind: 'draft', revisionId: versions.theirs, region: theirs.region },
    attachments: [...versions.yours.attachments, ...theirs.opened.payload.attachments],
  };
}

/** A merge with the change another window saved into this device's queue. */
export async function openWindowMerge(session: DraftSession): Promise<OpenedMerge> {
  const versions = await session.windowMergeVersions();
  if (!versions) throw new CantMerge(NOTHING);
  const { base, theirs, yours } = versions;
  return {
    merge: pageMerge.mergePayloads(base, yours, theirs.payload),
    theirs: { kind: 'window' },
    over: { kind: 'window', ...theirs },
    attachments: [...yours.attachments, ...theirs.payload.attachments],
  };
}

/** Who saved a version, by its author, as the app names people: by their contact label. */
async function whoseIs(
  ctx: ClientContext,
  queryClient: QueryClient,
  authorId: string,
): Promise<Theirs> {
  if (authorId === ctx.identity.public.id) return { kind: 'self' };
  const people = await queryClient.fetchQuery(peopleQuery(ctx, [authorId])).catch(() => null);
  const person = people?.get(authorId);
  return person && !person.nameless ? { kind: 'person', name: person.name } : { kind: 'unknown' };
}
