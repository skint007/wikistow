import { z } from 'zod';
import type { RouteDef } from '../route.ts';
import { Email, Role } from './accounts.ts';

// Every admin route requires an administrator. Every one that changes
// something also requires a recent sign-in (`reauth-required` otherwise).
// Responses are strict: they can never carry content, keys, or vault data.

const AccountId = z.object({ id: z.uuid() });
const Done = z.strictObject({ ok: z.literal(true) });

export const AdminAccount = z.strictObject({
  id: z.uuid(),
  email: Email,
  name: z.string(),
  role: Role,
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  suspended: z.boolean(),
  createdAt: z.iso.datetime(),
  sessionCount: z.number().int(),
  lastSeenAt: z.iso.datetime().nullable(),
});

export const PendingInvitation = z.strictObject({
  id: z.uuid(),
  email: Email.nullable(),
  role: Role,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastSentAt: z.iso.datetime().nullable(),
});

export const listAccounts = {
  method: 'GET',
  path: '/api/admin/accounts',
  response: z.strictObject({ accounts: z.array(AdminAccount) }),
} as const satisfies RouteDef;

export const setRole = {
  method: 'POST',
  path: '/api/admin/accounts/:id/role',
  params: AccountId,
  body: z.object({ role: Role }),
  response: Done,
} as const satisfies RouteDef;

export const suspend = {
  method: 'POST',
  path: '/api/admin/accounts/:id/suspend',
  params: AccountId,
  response: Done,
} as const satisfies RouteDef;

export const reactivate = {
  method: 'POST',
  path: '/api/admin/accounts/:id/reactivate',
  params: AccountId,
  response: Done,
} as const satisfies RouteDef;

/** Sign someone out everywhere and end their agents' credentials (protocol section 9.7). */
export const revokeSessions = {
  method: 'POST',
  path: '/api/admin/accounts/:id/revoke-sessions',
  params: AccountId,
  response: Done,
} as const satisfies RouteDef;

export const resendVerification = {
  method: 'POST',
  path: '/api/admin/accounts/:id/resend-verification',
  params: AccountId,
  response: Done,
} as const satisfies RouteDef;

export const listInvitations = {
  method: 'GET',
  path: '/api/admin/invitations',
  response: z.strictObject({ invitations: z.array(PendingInvitation) }),
} as const satisfies RouteDef;

/**
 * Invite by email (the link is mailed) or create a generic single-use link,
 * which is returned once and never stored.
 */
export const createInvitation = {
  method: 'POST',
  path: '/api/admin/invitations',
  body: z.object({ email: Email.nullable(), role: Role }),
  response: z.strictObject({ invitation: PendingInvitation, link: z.url().nullable() }),
  status: 201,
} as const satisfies RouteDef;

/** New token and expiry; the old link stops working. */
export const resendInvitation = {
  method: 'POST',
  path: '/api/admin/invitations/:id/resend',
  params: AccountId,
  response: z.strictObject({ invitation: PendingInvitation, link: z.url().nullable() }),
} as const satisfies RouteDef;

/**
 * New token and expiry, returned to copy and never mailed; the old link stops
 * working, as on resend.
 */
export const newInvitationLink = {
  method: 'POST',
  path: '/api/admin/invitations/:id/link',
  params: AccountId,
  response: z.strictObject({ invitation: PendingInvitation, link: z.url() }),
} as const satisfies RouteDef;

export const revokeInvitation = {
  method: 'DELETE',
  path: '/api/admin/invitations/:id',
  params: AccountId,
  response: Done,
} as const satisfies RouteDef;

export const getSettings = {
  method: 'GET',
  path: '/api/admin/settings',
  response: z.strictObject({ publicRegistration: z.boolean() }),
} as const satisfies RouteDef;

export const updateSettings = {
  method: 'PUT',
  path: '/api/admin/settings',
  body: z.object({ publicRegistration: z.boolean() }),
  response: z.strictObject({ publicRegistration: z.boolean() }),
} as const satisfies RouteDef;
