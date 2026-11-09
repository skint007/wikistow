import type { pluginProposalRoutes } from '@wikistow/contracts';
import { MANIFEST_FILE } from '@wikistow/plugin-sdk/manifest';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ContentError } from '../content/errors.ts';
import type { Database } from '../db/client.ts';
import {
  pluginDraftFiles,
  pluginDrafts,
  pluginProposalFiles,
  pluginProposals,
  plugins,
  pluginVersions,
  users,
} from '../db/schema/index.ts';
import {
  checkFiles,
  draftName,
  rowsOf,
  sourceOf,
  storePluginDraft,
  withId,
  type DraftBytes,
  type DraftText,
} from './drafts.ts';
import type { PluginStore } from './store.ts';

/*
 * Plugin proposals (#315): a copy draft's files, sent back to the owner of
 * the plugin it copies under that plugin's ID, for them to open as a draft
 * of their own or decline. The sender and the owner each see only their
 * own side: the sender proposes from their draft, the owner reads, opens
 * and declines. Anyone else's proposal is `not-found`.
 */

const notFound = () => new ContentError('not-found', 'No such plugin proposal');

type Draft = { accountId: string; draftId: string };
type Proposal = { accountId: string; proposalId: string };

const senders = alias(users, 'senders');
const owners = alias(users, 'owners');

/** Proposals' summaries, newest first. */
async function summaries(db: Database, where: SQL | undefined) {
  const rows = await db
    .select({
      id: pluginProposals.id,
      pluginId: pluginProposals.pluginId,
      hash: pluginProposals.fromHash,
      name: pluginProposals.name,
      fromName: senders.name,
      toName: owners.name,
      createdAt: pluginProposals.createdAt,
      files: sql<number>`count(${pluginProposalFiles.path})::int`,
      size: sql<number>`coalesce(sum(${pluginProposalFiles.size}), 0)::int`,
    })
    .from(pluginProposals)
    .innerJoin(plugins, eq(plugins.id, pluginProposals.pluginId))
    .innerJoin(senders, eq(senders.id, pluginProposals.senderId))
    .innerJoin(owners, eq(owners.id, plugins.ownerId))
    .leftJoin(pluginProposalFiles, eq(pluginProposalFiles.proposalId, pluginProposals.id))
    .where(where)
    .groupBy(pluginProposals.id, senders.name, owners.name)
    .orderBy(desc(pluginProposals.createdAt));
  return rows.map(({ fromName, toName, createdAt, ...row }) => ({
    ...row,
    from: { name: fromName },
    to: { name: toName },
    createdAt: createdAt.toISOString(),
  }));
}

/** A proposal for one of the caller's plugins. */
async function received(db: Database, { accountId, proposalId }: Proposal) {
  const [summary] = await summaries(
    db,
    and(eq(pluginProposals.id, proposalId), eq(plugins.ownerId, accountId)),
  );
  if (!summary) throw notFound();
  return summary;
}

/**
 * The caller's draft, if it is a copy of another account's plugin: the
 * plugin it copies, from which version, and its owner's name.
 */
async function copied(db: Database, { accountId, draftId }: Draft) {
  const [row] = await db
    .select({
      pluginId: pluginDrafts.fromPluginId,
      hash: pluginDrafts.fromHash,
      ownerId: plugins.ownerId,
      ownerName: users.name,
    })
    .from(pluginDrafts)
    .leftJoin(plugins, eq(plugins.id, pluginDrafts.fromPluginId))
    .leftJoin(users, eq(users.id, plugins.ownerId))
    .where(and(eq(pluginDrafts.id, draftId), eq(pluginDrafts.ownerId, accountId)));
  if (!row) throw new ContentError('not-found', 'No such plugin draft');
  const { pluginId, hash, ownerId, ownerName } = row;
  if (pluginId === null || hash === null || ownerId === null || ownerName === null) return null;
  if (ownerId === accountId) return null;
  return { pluginId, hash, owner: { name: ownerName } };
}

/**
 * Whom the caller's draft would go to, or null when it is no copy of
 * another account's plugin, and the caller's proposal for that plugin,
 * if the owner hasn't opened or declined it.
 */
export async function readDraftProposal(db: Database, draft: Draft) {
  const copy = await copied(db, draft);
  if (!copy) return { to: null, sent: null };
  const [sent] = await summaries(
    db,
    and(eq(pluginProposals.senderId, draft.accountId), eq(pluginProposals.pluginId, copy.pluginId)),
  );
  return { to: copy.owner, sent: sent ?? null };
}

/**
 * Propose the caller's copy draft to the plugin's owner: its files now,
 * the manifest's ID set back to the plugin's, in place of the caller's
 * earlier proposal for it.
 */
export async function proposePluginDraft(db: Database, draft: Draft) {
  const copy = await copied(db, draft);
  if (!copy) {
    throw new ContentError(
      'invalid-plugin',
      'This draft isn’t a copy of someone else’s plugin, so there’s no one to propose it to.',
    );
  }
  const files = await db
    .select({
      path: pluginDraftFiles.path,
      text: pluginDraftFiles.text,
      data: pluginDraftFiles.data,
    })
    .from(pluginDraftFiles)
    .where(eq(pluginDraftFiles.draftId, draft.draftId));
  const texts = withId(
    files.flatMap(({ path, text }) => (text === null ? [] : [{ path, text }])),
    copy.pluginId,
    `The draft’s ${MANIFEST_FILE} isn’t readable, so its ID can’t be set back to ${copy.pluginId}. Ask the assistant to fix it first.`,
  );
  const binary = files.flatMap(({ path, data }) => (data === null ? [] : [{ path, data }]));
  const rows = rowsOf(texts, binary);
  // Within the draft's limits already, unless its manifest grew a little.
  checkFiles(rows);

  const id = await db.transaction(async (tx) => {
    await tx
      .delete(pluginProposals)
      .where(
        and(
          eq(pluginProposals.senderId, draft.accountId),
          eq(pluginProposals.pluginId, copy.pluginId),
        ),
      );
    const [proposal] = await tx
      .insert(pluginProposals)
      .values({
        pluginId: copy.pluginId,
        senderId: draft.accountId,
        fromHash: copy.hash,
        name: draftName(texts),
      })
      .returning({ id: pluginProposals.id });
    if (!proposal) throw new Error('plugin proposal was not stored');
    if (rows.length > 0) {
      await tx
        .insert(pluginProposalFiles)
        .values(rows.map((row) => ({ ...row, proposalId: proposal.id })));
    }
    return proposal.id;
  });
  const [summary] = await summaries(db, eq(pluginProposals.id, id));
  if (!summary) throw notFound();
  return summary;
}

/** Proposals for the caller's plugins, newest first. */
export const listPluginProposals = (db: Database, accountId: string) =>
  summaries(db, eq(plugins.ownerId, accountId));

/** A proposal's files: text, and fonts and images as bytes. */
async function filesOf(db: Database, proposalId: string) {
  const rows = await db
    .select({
      path: pluginProposalFiles.path,
      text: pluginProposalFiles.text,
      data: pluginProposalFiles.data,
    })
    .from(pluginProposalFiles)
    .where(eq(pluginProposalFiles.proposalId, proposalId))
    .orderBy(pluginProposalFiles.path);
  const texts: DraftText[] = rows.flatMap(({ path, text }) =>
    text === null ? [] : [{ path, text }],
  );
  const binary: DraftBytes[] = rows.flatMap(({ path, data }) =>
    data === null ? [] : [{ path, data }],
  );
  return { texts, binary };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/**
 * A manifest's text laid out as proposing writes it (`withId`), so a diff
 * against it shows only what changed: unchanged as it is when unreadable.
 */
function laidOut(text: string) {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return text;
  }
}

/**
 * A proposal for one of the caller's plugins, with each file it adds,
 * changes or removes against the version it started from, by path, and
 * whether that version is the plugin's newest, older, or gone.
 */
export async function readPluginProposal(db: Database, store: PluginStore, proposal: Proposal) {
  const summary = await received(db, proposal);
  const after = await filesOf(db, proposal.proposalId);
  const before = await sourceOf(db, store, proposal.accountId, {
    pluginId: summary.pluginId,
    hash: summary.hash,
  }).catch((failure: unknown) => {
    if (failure instanceof ContentError && failure.code === 'not-found') return null;
    throw failure;
  });
  const [newest] = await db
    .select({ hash: pluginVersions.hash })
    .from(pluginVersions)
    .where(eq(pluginVersions.pluginId, summary.pluginId))
    .orderBy(desc(pluginVersions.createdAt))
    .limit(1);
  const base: 'newest' | 'older' | 'gone' = !before
    ? 'gone'
    : newest?.hash === summary.hash
      ? 'newest'
      : 'older';

  type Side = { text: string | null; data: Uint8Array | null };
  const sides = (files: { texts: DraftText[]; binary: DraftBytes[] }) =>
    new Map<string, Side>([
      ...files.texts.map(({ path, text }): [string, Side] => [path, { text, data: null }]),
      ...files.binary.map(({ path, data }): [string, Side] => [path, { text: null, data }]),
    ]);
  const same = (a: Side, b: Side) =>
    a.text === b.text &&
    (a.data === null || b.data === null ? a.data === b.data : sameBytes(a.data, b.data));
  // The proposal's manifest is written out again with the ID set back: the version's is too.
  const laid = before && {
    ...before,
    texts: before.texts.map((file) =>
      file.path === MANIFEST_FILE ? { ...file, text: laidOut(file.text) } : file,
    ),
  };
  const was = sides(laid ?? { texts: [], binary: [] });
  const now = sides(after);
  const paths = [...new Set([...was.keys(), ...now.keys()])].sort();
  const changes = paths.flatMap((path): pluginProposalRoutes.ProposalChange[] => {
    const old = was.get(path);
    const next = now.get(path);
    if (old && next && same(old, next)) return [];
    return [
      {
        path,
        change: !old ? 'added' : !next ? 'removed' : 'changed',
        before: old?.text ?? null,
        after: next?.text ?? null,
      },
    ];
  });
  return { proposal: summary, base, changes };
}

/**
 * Open a proposal for one of the caller's plugins as a draft of their own,
 * from the version it started from, and forget it, in one transaction.
 */
export async function openPluginProposal(
  db: Database,
  { replaces, ...proposal }: Proposal & { replaces?: string | undefined },
) {
  const summary = await received(db, proposal);
  const { texts, binary } = await filesOf(db, proposal.proposalId);
  return storePluginDraft(db, {
    accountId: proposal.accountId,
    from: { pluginId: summary.pluginId, hash: summary.hash },
    texts,
    binary,
    replaces,
    // Gone meanwhile, as when it was declined on another device, or proposed again.
    within: async (tx) => {
      const gone = await tx
        .delete(pluginProposals)
        .where(eq(pluginProposals.id, proposal.proposalId))
        .returning({ id: pluginProposals.id });
      if (gone.length === 0) throw notFound();
    },
  });
}

/** Decline a proposal for one of the caller's plugins. */
export async function declinePluginProposal(db: Database, proposal: Proposal) {
  await received(db, proposal);
  await db.delete(pluginProposals).where(eq(pluginProposals.id, proposal.proposalId));
}
