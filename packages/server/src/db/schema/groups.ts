import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { SHARE_ROLES, shares } from './shares.ts';
import { spaces } from './spaces.ts';
import { users } from './users.ts';

/**
 * Groups of people in one space that shares go to as one (section 7.8).
 * IDs are made by clients. A group's name is an owner-region metadata
 * record (`subjectKind: "group"`), its current version `metadataHead`.
 * Groups hold no keys: folder keys are still sealed to each member.
 */
export const groups = pgTable(
  'groups',
  {
    id: text().primaryKey(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    metadataHead: text().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('groups_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    index('groups_space_idx').on(table.spaceId),
  ],
);

/**
 * Who is in each group: a person, or an agent for its person. Not signed:
 * a membership is only the owners' instruction about whom to seal to.
 * `accountId` is the identity's account, so deleting it removes them.
 */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    identityId: text().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    /**
     * For an agent: null until its person confirms the group (section 9.4),
     * then whether it gets draft keys through it. Always null for a person.
     */
    agentDrafts: boolean(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.identityId] }),
    index('group_members_identity_idx').on(table.identityId),
    check(
      'group_members_agent_drafts',
      sql`${table.agentDrafts} is null or ${table.identityId} like 'agent-%'`,
    ),
  ],
);

/** The shares each group has, with its access there. Group and share are in one space. */
export const shareGroups = pgTable(
  'share_groups',
  {
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    groupId: text()
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    role: text({ enum: SHARE_ROLES }).notNull(),
    canPublish: boolean().notNull().default(false),
    addedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shareId, table.groupId] }),
    check('share_groups_role', sql`${table.role} in ('reader', 'editor')`),
    check(
      'share_groups_readers_never_publish',
      sql`${table.role} <> 'reader' or not ${table.canPublish}`,
    ),
    index('share_groups_group_idx').on(table.groupId),
  ],
);
