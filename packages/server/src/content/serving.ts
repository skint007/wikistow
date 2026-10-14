// Records as the server serves them (protocol section 16): each with its key
// wrap if it is in a share, or else the caller's own envelopes for it.
import {
  KeyEnvelope,
  KeyEnvelopeV2,
  KeyWrap,
  MetadataEnvelope,
  MetadataEnvelopeV2,
  SealedMetadata,
  SealedMetadataV2,
  type PublicIdentity,
} from '@wikistow/contracts';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import {
  keyEnvelopes,
  metadataRevisions,
  metadataWraps,
  revisionWraps,
} from '../db/schema/index.ts';
import { readStored, type ReportUnreadable } from './stored.ts';

// Milestone 1 records and envelopes are served beside Milestone 2 ones.
export const AnyMetadata = z.union([SealedMetadata, SealedMetadataV2]);
const AnyMetadataEnvelope = z.union([MetadataEnvelope, MetadataEnvelopeV2]);
const AnyKeyEnvelope = z.union([KeyEnvelope, KeyEnvelopeV2]);

/** A record's key material: its wrap, or the caller's own envelopes for it. Exactly one is set. */
export type KeyMaterial<E> = { wrap: KeyWrap; envelopes: [] } | { wrap: null; envelopes: E[] };

/**
 * The key material each of `ids` is served with to `identity`, at its
 * current key. A record with neither a wrap nor an envelope of theirs is
 * left out, as is a stored wrap or envelope the current schemas refuse,
 * which is reported.
 */
async function keyMaterial<E>(
  db: Database,
  identity: PublicIdentity,
  ids: readonly string[],
  {
    subjectKind,
    envelope,
    report,
  }: { subjectKind: 'revision' | 'metadata'; envelope: z.ZodType<E>; report: ReportUnreadable },
): Promise<Map<string, KeyMaterial<E>>> {
  const out = new Map<string, KeyMaterial<E>>();
  if (ids.length === 0) return out;
  const wraps =
    subjectKind === 'revision'
      ? await db
          .select({ id: revisionWraps.revisionId, wrap: revisionWraps.wrap })
          .from(revisionWraps)
          .where(inArray(revisionWraps.revisionId, [...ids]))
      : await db
          .select({ id: metadataWraps.metadataRevisionId, wrap: metadataWraps.wrap })
          .from(metadataWraps)
          .where(inArray(metadataWraps.metadataRevisionId, [...ids]));
  for (const row of wraps) {
    const table = `${subjectKind}_wraps`;
    const wrap = readStored(KeyWrap, row.wrap, { table, id: row.id }, report);
    if (wrap) out.set(row.id, { wrap, envelopes: [] });
  }
  const wrapped = new Set(wraps.map((row) => row.id));
  const rest = ids.filter((id) => !wrapped.has(id));
  if (rest.length === 0) return out;
  const envelopes = await db
    .select()
    .from(keyEnvelopes)
    .where(
      and(
        eq(keyEnvelopes.subjectKind, subjectKind),
        inArray(keyEnvelopes.subjectId, rest),
        eq(keyEnvelopes.recipientIdentityId, identity.id),
        eq(keyEnvelopes.recipientKeyVersion, identity.keyVersion),
      ),
    );
  for (const row of envelopes) {
    const stored = { table: 'key_envelopes', id: row.subjectId };
    const parsed = readStored(envelope, row.envelope, stored, report);
    if (parsed === undefined) continue;
    const held = out.get(row.subjectId);
    out.set(row.subjectId, { wrap: null, envelopes: [...(held?.envelopes ?? []), parsed] });
  }
  return out;
}

/** The key material of page versions, as served to `identity`. */
export const revisionKeyMaterial = (
  db: Database,
  identity: PublicIdentity,
  ids: readonly string[],
  report: ReportUnreadable,
) => keyMaterial(db, identity, ids, { subjectKind: 'revision', envelope: AnyKeyEnvelope, report });

/**
 * Metadata versions with the key material each is served with to
 * `identity`. A version the current schemas refuse is left out and
 * reported, and so is one served with no key material.
 */
export async function servedMetadata(
  db: Database,
  identity: PublicIdentity,
  ids: readonly string[],
  report: ReportUnreadable,
) {
  type Served = { metadata: z.output<typeof AnyMetadata> } & KeyMaterial<
    z.output<typeof AnyMetadataEnvelope>
  >;
  const out = new Map<string, Served>();
  if (ids.length === 0) return out;
  const material = await keyMaterial(db, identity, ids, {
    subjectKind: 'metadata',
    envelope: AnyMetadataEnvelope,
    report,
  });
  const versions = await db
    .select({ id: metadataRevisions.id, sealed: metadataRevisions.sealed })
    .from(metadataRevisions)
    .where(inArray(metadataRevisions.id, [...material.keys()]));
  for (const version of versions) {
    const keys = material.get(version.id);
    if (!keys) continue;
    const row = { table: 'metadata_revisions', id: version.id };
    const metadata = readStored(AnyMetadata, version.sealed, row, report);
    if (metadata) out.set(version.id, { metadata, ...keys });
  }
  return out;
}
