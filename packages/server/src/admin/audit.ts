import { z } from 'zod';
import type { Database } from '../db/client.ts';
import { auditEvents, ROLES } from '../db/schema/index.ts';

// Each action's details: IDs, enums, and counts only. Strict, so a stray
// field (a name, an email, a reason someone typed) is rejected, not stored.
const DETAILS = {
  'account.role-changed': z.strictObject({
    role: z.enum(ROLES),
    sessionsRevoked: z.number().int(),
    invitationsRevoked: z.number().int(),
  }),
  'account.suspended': z.strictObject({
    sessionsRevoked: z.number().int(),
    invitationsRevoked: z.number().int(),
  }),
  'account.reactivated': z.strictObject({}),
  'account.sessions-revoked': z.strictObject({ sessionsRevoked: z.number().int() }),
  'account.verification-resent': z.strictObject({}),
  // A new installation's first account, made on its setup page.
  'account.first-admin': z.strictObject({}),
  'invitation.created': z.strictObject({ role: z.enum(ROLES), emailBound: z.boolean() }),
  // A new link replaced the old one; `mailed` if it went to the invited address.
  'invitation.resent': z.strictObject({ mailed: z.boolean() }),
  'invitation.revoked': z.strictObject({}),
  'settings.updated': z.strictObject({ publicRegistration: z.boolean() }),
  // Which fields an administrator changed, never their values.
  'settings.mail-updated': z.strictObject({
    changed: z.array(z.enum(['host', 'port', 'security', 'username', 'password', 'from'])),
  }),
  'settings.ai-updated': z.strictObject({
    changed: z.array(
      z.enum(['style', 'baseUrl', 'apiKey', 'model', 'maxOutputTokens', 'requestsPerMinute']),
    ),
  }),
  // Sharing: who was given or lost keys, by identity ID, never by name.
  'share.created': z.strictObject({
    spaceId: z.string(),
    rootId: z.string().nullable(),
    members: z.array(z.string()),
    agents: z.array(z.string()),
    groups: z.array(z.string()),
    records: z.number().int(),
  }),
  'share.member-added': z.strictObject({
    identityId: z.string(),
    role: z.enum(['reader', 'editor']),
    canPublish: z.boolean(),
  }),
  'share.rotated': z.strictObject({
    keyVersion: z.number().int(),
    removed: z.array(z.string()),
    demoted: z.array(z.string()),
    /** The group whose change made the rotation, if one did. */
    groupId: z.string().optional(),
  }),
  'share.group-added': z.strictObject({
    groupId: z.string(),
    role: z.enum(['reader', 'editor']),
    canPublish: z.boolean(),
  }),
  'share.group-changed': z.strictObject({
    groupId: z.string(),
    role: z.enum(['reader', 'editor']),
    canPublish: z.boolean(),
  }),
  'share.group-removed': z.strictObject({ groupId: z.string() }),
  // Groups: IDs only. A group's name is encrypted, for the space's owners.
  'group.created': z.strictObject({ spaceId: z.string() }),
  'group.deleted': z.strictObject({ spaceId: z.string(), shares: z.number().int() }),
  'group.member-added': z.strictObject({ identityId: z.string() }),
  'group.member-removed': z.strictObject({ identityId: z.string() }),
  // A move across a share boundary, which rewraps its records (null: the owner region).
  'node.moved': z.strictObject({
    spaceId: z.string(),
    fromShare: z.string().nullable(),
    toShare: z.string().nullable(),
    records: z.number().int(),
  }),
  // A page or folder copied, or moved into another space, with everything
  // under it (section 10): where to, the new top node, and how many nodes.
  'node.copied': z.strictObject({
    spaceId: z.string(),
    toSpaceId: z.string(),
    nodeId: z.string(),
    nodes: z.number().int(),
  }),
  'node.moved-between-spaces': z.strictObject({
    spaceId: z.string(),
    toSpaceId: z.string(),
    nodeId: z.string(),
    nodes: z.number().int(),
  }),
  // A page's public link (ADR 0005), never its id: who turned it on is the
  // actor, and how it ended. One that lapsed names who turned it on, and
  // has as its actor whoever's change took their rights, or none when
  // serving or the sweep found it.
  'node.public-link-on': z.strictObject({ spaceId: z.string() }),
  'node.public-link-off': z.strictObject({
    spaceId: z.string(),
    sharedBy: z.string(),
    reason: z.enum(['turned-off', 'unpublished', 'lost-publish-rights']),
  }),
  'space.owner-added': z.strictObject({ identityId: z.string(), keyVersion: z.number().int() }),
  'space.owner-removed': z.strictObject({ identityId: z.string(), shares: z.number().int() }),
  // How much went with it, never what.
  'space.deleted': z.strictObject({ nodes: z.number().int(), shares: z.number().int() }),
  // Agents: which shares a person granted their agent, by ID.
  'agent.enrolled': z.strictObject({ shares: z.array(z.string()) }),
  'agent.granted': z.strictObject({
    shareId: z.string(),
    role: z.enum(['reader', 'editor']),
    canPublish: z.boolean(),
  }),
  'agent.grant-removed': z.strictObject({ shareId: z.string() }),
  // A person confirms a group an owner put their agent in, or takes it out.
  'agent.group-confirmed': z.strictObject({ groupId: z.string(), drafts: z.boolean() }),
  'agent.group-left': z.strictObject({ groupId: z.string() }),
  'agent.revoked': z.strictObject({}),
};

export type AuditAction = keyof typeof DETAILS;

export async function audit<A extends AuditAction>(
  db: Database,
  event: {
    actor: string | null;
    action: A;
    target: {
      kind: 'account' | 'agent' | 'group' | 'invitation' | 'node' | 'settings' | 'share' | 'space';
      id: string;
    };
    details: z.input<(typeof DETAILS)[A]>;
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    actorKind: event.actor === null ? 'operator' : 'account',
    actorAccountId: event.actor,
    action: event.action,
    targetKind: event.target.kind,
    targetId: event.target.id,
    details: DETAILS[event.action].parse(event.details),
  });
}
