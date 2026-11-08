import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { nodes, spaces } from './spaces.ts';
import { users } from './users.ts';

/**
 * Copies of a page or folder, and moves into another space (protocol
 * section 10, "Copies, and moves between spaces"). The new nodes are made
 * hidden (`nodes.copyId`), get their records, and are shown at the finish,
 * which for a move deletes the source too. The source isn't a foreign key,
 * so deleting it never deletes the copy: a copy whose source node is
 * deleted meanwhile then fails at its finish, as a move whose source
 * changed does, and one that lost only nodes under it shows what was
 * sealed from them. One nobody finishes is swept with its
 * nodes a day after its last request (`touchedAt`). A finished one is kept
 * a day (`finishedAt`), its nodes no longer tied to it, so a finish sent
 * again gets the same answer.
 */
export const copies = pgTable(
  'copies',
  {
    id: text().primaryKey(),
    kind: text({ enum: ['copy', 'move'] }).notNull(),
    /** Whether pages' published versions come along, where the opener can publish. */
    bringsPublished: boolean().notNull(),
    /** The responsible account, including when an agent opens it. */
    openedBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who opened it, a person or an agent: only they send to it and finish it. */
    openerId: text().notNull(),
    sourceSpaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Null for the top of the space: everything in it (#339). */
    sourceNodeId: text(),
    /** The source node's (or for the top of the space, the space's) permission version the preview was made at. */
    sourcePermissionVersion: bigint({ mode: 'number' }).notNull(),
    destinationSpaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Null for the top of the space. */
    destinationParentId: text(),
    /** The destination parent's (or space's) permission version the records are written at. */
    permissionVersion: bigint({ mode: 'number' }).notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    touchedAt: timestamptz().notNull().defaultNow(),
    /** When it finished; until then, null. */
    finishedAt: timestamptz(),
  },
  (table) => [
    check('copies_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check(
      'copies_move_elsewhere',
      sql`${table.kind} = 'copy' or ${table.sourceSpaceId} <> ${table.destinationSpaceId}`,
    ),
    index('copies_touched_at_idx').on(table.touchedAt),
    index('copies_finished_at_idx')
      .on(table.finishedAt)
      .where(sql`${table.finishedAt} is not null`),
  ],
);

/**
 * A copy's new nodes, each with the source node it copies and the source
 * versions its records were sealed from: a page's draft and, when it came
 * along, published version; a folder's metadata version. Null until its
 * records arrive. For a move, the finish checks they are still the source's
 * heads. The records themselves are the hidden node's own versions.
 */
export const copyNodes = pgTable(
  'copy_nodes',
  {
    nodeId: text()
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    copyId: text()
      .notNull()
      .references(() => copies.id, { onDelete: 'cascade' }),
    sourceId: text().notNull(),
    /** The new node's parent's source, or null for the copy's top node. */
    sourceParentId: text(),
    draftFrom: text(),
    publishedFrom: text(),
    metadataFrom: text(),
  },
  (table) => [index('copy_nodes_copy_idx').on(table.copyId)],
);

/**
 * Where each node a move took into another space went (protocol section
 * 10, "Old addresses"): its old ID and space, and the node that copies it
 * now. Written in the move's finish, so an old address, or a link from a
 * page left behind, opens the new place for anyone who can open it. A move
 * of the new node points its records on at the node it moves to, so a
 * chain of moves is one step. The records last as long as the new node:
 * deleting it for good, or its space, removes them (`forgetMoves`). No
 * foreign key does, as its trigger would slow every large delete.
 */
export const movedNodes = pgTable(
  'moved_nodes',
  {
    /** Node IDs are unique across the installation, so the old ID names one. */
    oldId: text().primaryKey(),
    /** No foreign key: the old space may be deleted, and the record kept. */
    oldSpaceId: text().notNull(),
    newSpaceId: text().notNull(),
    newId: text().notNull(),
    movedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [index('moved_nodes_new_idx').on(table.newSpaceId, table.newId)],
);
