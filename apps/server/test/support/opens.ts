// What someone's own keys open of everything stored, and every answer the
// server gives them: the milestone proofs' evidence, past API refusals.
import {
  decryptRevisionPayload,
  metadataWrapSubject,
  RevisionId,
  revisionWrapSubject,
  unwrapContentKey,
  type ApiClient,
  type ClientContext,
  type PrivateIdentity,
  type SpaceId,
} from '@wikistow/client';
import { stealableKeys } from '@wikistow/client/testing';
import {
  MetadataRecord,
  MetadataRecordV2,
  pageRoutes,
  RevisionRecord,
  RevisionRecordV2,
} from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { asAgent, type Agent } from './agents.ts';
import type { TestApp } from './harness.ts';
import type { Person } from './sharing.ts';

/** Someone's keys: a person's, or an agent's. */
export type KeyHolder = { identity: PrivateIdentity; ctx: ClientContext };

export const keysOf = (person: Person): KeyHolder => ({
  identity: person.vault.identity,
  ctx: person.ctx,
});

const AnyRevisionRecord = z.union([RevisionRecord, RevisionRecordV2]);
const AnyMetadataRecord = z.union([MetadataRecord, MetadataRecordV2]);
// Revision and metadata envelopes, v1 and v2 alike: all that matters here is the sealed key.
const AnyEnvelope = z.looseObject({ sealedKey: z.string() });

/**
 * Everything stored that `holder`'s keys open, by any key they hold: their
 * folder keys, through every stored wrap, and anything sealed to them in
 * any envelope. The revisions, with their decrypted text, and the folders
 * and spaces whose names they can open.
 */
export async function whatOpens(t: TestApp, { identity, ctx }: KeyHolder) {
  const envelopesFor = async (subjectKind: 'revision' | 'metadata') =>
    (
      await t.db
        .select({
          subjectId: schema.keyEnvelopes.subjectId,
          envelope: schema.keyEnvelopes.envelope,
        })
        .from(schema.keyEnvelopes)
        .where(eq(schema.keyEnvelopes.subjectKind, subjectKind))
    ).map((row) => ({ subjectId: row.subjectId, envelope: AnyEnvelope.parse(row.envelope) }));
  const keysFrom = (rows: { subjectId: string; envelope: { sealedKey: string } }[], id: string) =>
    stealableKeys(
      rows.filter((row) => row.subjectId === id).map((row) => row.envelope),
      identity,
    );
  const unwrap = (
    subject: Parameters<typeof unwrapContentKey>[0]['subject'],
    wrap: unknown,
    commitment: string | null,
  ) => {
    if (wrap === null) return [];
    try {
      return [
        unwrapContentKey({
          installationId: ctx.installationId,
          subject,
          wrap,
          keyring: ctx.keyring,
          commitment,
        }),
      ];
    } catch {
      return [];
    }
  };

  const revisionEnvelopes = await envelopesFor('revision');
  const revisions = await t.db
    .select({ sealed: schema.revisions.sealed, wrap: schema.revisionWraps.wrap })
    .from(schema.revisions)
    .leftJoin(schema.revisionWraps, eq(schema.revisionWraps.revisionId, schema.revisions.id));
  const opened = revisions.flatMap(({ sealed, wrap }) => {
    const raw = sealed as { record: unknown; payload: never };
    const record = AnyRevisionRecord.parse(raw.record);
    const commitment = record.protocol === 2 ? record.keyCommitment : null;
    const keys = [
      ...unwrap(revisionWrapSubject(record), wrap, commitment),
      ...keysFrom(revisionEnvelopes, record.revisionId),
    ];
    for (const contentKey of keys) {
      try {
        const payload = decryptRevisionPayload({ record, payload: raw.payload, contentKey });
        return [{ record, text: JSON.stringify(payload) }];
      } catch {
        // Not this key.
      }
    }
    return [];
  });

  const metadataEnvelopes = await envelopesFor('metadata');
  const metadata = await t.db
    .select({ sealed: schema.metadataRevisions.sealed, wrap: schema.metadataWraps.wrap })
    .from(schema.metadataRevisions)
    .leftJoin(
      schema.metadataWraps,
      eq(schema.metadataWraps.metadataRevisionId, schema.metadataRevisions.id),
    );
  const names = metadata.flatMap(({ sealed, wrap }) => {
    const record = AnyMetadataRecord.parse((sealed as { record: unknown }).record);
    const commitment = record.protocol === 2 ? record.keyCommitment : null;
    const keys = [
      ...unwrap(metadataWrapSubject(record), wrap, commitment),
      ...keysFrom(metadataEnvelopes, record.metadataRevisionId),
    ];
    return keys.length > 0 ? [record.subjectId] : [];
  });
  return { revisions: opened, names: new Set(names) };
}

/** How a test asks the server as someone: a GET of a path, and their API client. */
export type Asker = { get: (path: string) => Response | Promise<Response>; api: ApiClient };

export const asPerson = (person: Person): Asker => ({
  get: (path) => person.browser.fetch(path, { method: 'GET' }),
  api: person.api,
});

export const asAgentOf = (t: TestApp, agent: Agent): Asker => ({
  get: (path) => asAgent(t, agent.token, path),
  api: agent.api,
});

/**
 * Every answer `asker` gets from every route that reads, about `spaceId`
 * and its pages, and every stored revision they ask for by ID. `ownerId`
 * is looked up in the directory.
 */
export async function everyAnswer(
  t: TestApp,
  asker: Asker,
  { spaceId, ownerId }: { spaceId: SpaceId; ownerId: string },
) {
  const bodies: string[] = [];
  const statuses: Record<string, number> = {};
  const get = async (key: string, path: string) => {
    const res = await asker.get(path);
    bodies.push(await res.text());
    statuses[key] = res.status;
  };
  const nodes = await t.db
    .select({ id: schema.nodes.id, kind: schema.nodes.kind })
    .from(schema.nodes)
    .where(eq(schema.nodes.spaceId, spaceId));
  const shares = await t.db
    .select({ id: schema.shares.id, version: schema.shares.currentKeyVersion })
    .from(schema.shares)
    .where(eq(schema.shares.spaceId, spaceId));
  await get('spaces', '/api/spaces');
  await get('sharedWithMe', '/api/shared-with-me');
  await get('tree', `/api/spaces/${spaceId}/tree`);
  await get('spaceTarget', `/api/spaces/${spaceId}/target`);
  await get('owners', `/api/spaces/${spaceId}/owners`);
  await get('statements', `/api/spaces/${spaceId}/owner-statements`);
  await get('myEnvelopes', `/api/spaces/${spaceId}/my-envelopes`);
  await get('shares', `/api/spaces/${spaceId}/shares`);
  await get('records', `/api/spaces/${spaceId}/records?scope=owner-region`);
  await get('contacts', '/api/me/contacts');
  await get('agents', '/api/me/agents');
  await get('directory', `/api/directory?ids=${ownerId}`);
  for (const share of shares) {
    for (let v = 1; v <= share.version; v++) {
      await get(`envelopes:${share.id}:${v}`, `/api/shares/${share.id}/versions/${v}/envelopes`);
    }
  }
  for (const { id, kind } of nodes) {
    await get(`target:${id}`, `/api/spaces/${spaceId}/target?nodeId=${id}`);
    if (kind !== 'page') continue;
    await get(`page:${id}`, `/api/pages/${id}`);
    await get(`history:${id}`, `/api/pages/${id}/history`);
  }
  const ids = (await t.db.select({ id: schema.revisions.id }).from(schema.revisions)).map((r) =>
    RevisionId.parse(r.id),
  );
  for (let i = 0; i < ids.length; i += 200) {
    const batch = await asker.api.call(pageRoutes.fetchRevisions, {
      body: { ids: ids.slice(i, i + 200) },
    });
    bodies.push(JSON.stringify(batch));
  }
  const blobs = await t.db
    .select({ hash: schema.blobs.hash })
    .from(schema.blobs)
    .where(eq(schema.blobs.spaceId, spaceId));
  for (const { hash } of blobs) await get(`blob:${hash}`, `/api/blobs/${hash}`);
  return { text: bodies.join('\n'), statuses };
}
