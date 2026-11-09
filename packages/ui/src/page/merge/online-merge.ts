// Opening a merge for a draft someone else saved (`stale-head`, ADR 0013,
// decision 2): the three versions, merged, and whose theirs is.
import {
  pageMerge,
  type AttachmentRef,
  type ClientContext,
  type pageOperations,
  type Region,
  type RevisionId,
} from '@wikistow/client';
import type { QueryClient } from '@tanstack/react-query';
import { revisionQuery } from '../../data/queries';
import { peopleQuery } from '../../sharing/people';
import type { DraftSession } from '../draft-session';
import type { Theirs } from './merge-model';

/** A merge ready to show, and the version of theirs a save goes on top of. */
export type OpenedMerge = {
  merge: pageMerge.Merge;
  theirs: Theirs;
  /** The revision the merge read as theirs, and the region it opened in. */
  revisionId: RevisionId;
  region: Region;
  /** Both sides' attachments, for the pictures a banner or icon overlap shows. */
  attachments: readonly AttachmentRef[];
};

/** Thrown when there is nothing to merge, or theirs can't be read here. */
export class CantMerge extends Error {}

export async function openOnlineMerge(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  session: DraftSession,
  queryClient: QueryClient,
): Promise<OpenedMerge> {
  const versions = await session.mergeVersions();
  if (!versions) throw new CantMerge('There’s nothing to merge with now.');
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
    revisionId: versions.theirs,
    region: theirs.region,
    attachments: [...versions.yours.attachments, ...theirs.opened.payload.attachments],
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
