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
  'invitation.created': z.strictObject({ role: z.enum(ROLES), emailBound: z.boolean() }),
  'invitation.resent': z.strictObject({}),
  'invitation.revoked': z.strictObject({}),
  'settings.updated': z.strictObject({ publicRegistration: z.boolean() }),
  // Sharing: who was given or lost keys, by identity ID, never by name.
  'share.created': z.strictObject({
    spaceId: z.string(),
    rootId: z.string().nullable(),
    members: z.array(z.string()),
    agents: z.array(z.string()),
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
  }),
  // A move across a share boundary, which rewraps its records (null: the owner region).
  'node.moved': z.strictObject({
    spaceId: z.string(),
    fromShare: z.string().nullable(),
    toShare: z.string().nullable(),
    records: z.number().int(),
  }),
  'space.owner-added': z.strictObject({ identityId: z.string(), keyVersion: z.number().int() }),
  'space.owner-removed': z.strictObject({ identityId: z.string(), shares: z.number().int() }),
  // Agents: which shares a person granted their agent, by ID.
  'agent.enrolled': z.strictObject({ shares: z.array(z.string()) }),
  'agent.granted': z.strictObject({
    shareId: z.string(),
    role: z.enum(['reader', 'editor']),
    canPublish: z.boolean(),
  }),
  'agent.grant-removed': z.strictObject({ shareId: z.string() }),
  'agent.revoked': z.strictObject({}),
};

export type AuditAction = keyof typeof DETAILS;

export async function audit<A extends AuditAction>(
  db: Database,
  event: {
    actor: string | null;
    action: A;
    target: {
      kind: 'account' | 'agent' | 'invitation' | 'node' | 'settings' | 'share' | 'space';
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
