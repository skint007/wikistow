import { z } from 'zod';
import type { RouteDef } from '../route.ts';
import { Email, Role } from './accounts.ts';
import { AiProviderFailure, AiStyle } from './ai.ts';

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

export const SmtpSecurity = z.enum(['none', 'starttls', 'tls']);
export const MailField = z.enum(['host', 'port', 'security', 'username', 'password', 'from']);

/**
 * Outgoing mail as the admin page shows it. The password never comes back,
 * only whether one is saved. A field the server's environment sets is
 * listed in `environment`: the page shows it read-only and its value here
 * is null. `ready` says whether the server can send mail now.
 */
export const AdminMailSettings = z.strictObject({
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  security: SmtpSecurity.nullable(),
  username: z.string().nullable(),
  passwordSaved: z.boolean(),
  from: z.string().nullable(),
  environment: z.array(MailField),
  ready: z.boolean(),
});

/**
 * The mail form's values. A field left out keeps what is saved, and a null
 * clears it; so a left-out password keeps the saved one.
 */
export const MailForm = z.object({
  host: z.string().trim().min(1).max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  security: SmtpSecurity.nullable().optional(),
  username: z.string().trim().min(1).max(256).nullable().optional(),
  password: z.string().min(1).max(256).nullable().optional(),
  from: z.string().trim().min(3).max(320).nullable().optional(),
});

// Each settings group has its own route: released apps parse these
// responses strictly, so a group added to one would break them.
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

export const getMailSettings = {
  method: 'GET',
  path: '/api/admin/settings/mail',
  response: AdminMailSettings,
} as const satisfies RouteDef;

export const updateMailSettings = {
  method: 'PUT',
  path: '/api/admin/settings/mail',
  body: MailForm,
  response: AdminMailSettings,
} as const satisfies RouteDef;

/**
 * Send a test message to the administrator's own address with the form's
 * values, saved or not, and wait for the mail server's answer. A failure is
 * `mail-failed`, with a message saying why.
 */
export const sendTestMail = {
  method: 'POST',
  path: '/api/admin/settings/mail/test',
  body: MailForm,
  response: z.strictObject({ sentTo: Email }),
} as const satisfies RouteDef;

export const AiField = z.enum([
  'style',
  'baseUrl',
  'apiKey',
  'model',
  'maxOutputTokens',
  'requestsPerMinute',
]);

/**
 * The AI provider as the admin page shows it, like `AdminMailSettings`: the
 * key never comes back, only whether one is saved, and fields an `AI_*`
 * variable sets are listed in `environment` with a null value. `enabled`
 * says whether AI is on now.
 */
export const AdminAiSettings = z.strictObject({
  style: AiStyle.nullable(),
  baseUrl: z.string().nullable(),
  apiKeySaved: z.boolean(),
  model: z.string().nullable(),
  maxOutputTokens: z.number().int().nullable(),
  requestsPerMinute: z.number().int().nullable(),
  environment: z.array(AiField),
  enabled: z.boolean(),
});

/** The AI form's values, as `MailForm`: left out keeps, null clears. */
export const AiForm = z.object({
  style: AiStyle.nullable().optional(),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable()
    .optional(),
  apiKey: z.string().min(1).max(2000).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
  requestsPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

export const getAiSettings = {
  method: 'GET',
  path: '/api/admin/settings/ai',
  response: AdminAiSettings,
} as const satisfies RouteDef;

export const updateAiSettings = {
  method: 'PUT',
  path: '/api/admin/settings/ai',
  body: AiForm,
  response: AdminAiSettings,
} as const satisfies RouteDef;

export const AiModel = z.strictObject({ id: z.string(), name: z.string().nullable() });

/**
 * The provider's models for the form's style, base URL and key (the saved
 * key when none is given), sorted by ID, at most 2,000. The server asks the
 * provider, so the key never reaches the browser. `reason` says why the list
 * couldn't be had.
 */
export const listAiModels = {
  method: 'POST',
  path: '/api/admin/ai/models',
  body: AiForm.pick({ style: true, baseUrl: true, apiKey: true }),
  response: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), models: z.array(AiModel) }),
    z.strictObject({ ok: z.literal(false), reason: z.string() }),
  ]),
} as const satisfies RouteDef;

/** `aiRoutes.check` with the form's values, saved or not. */
export const checkAi = {
  method: 'POST',
  path: '/api/admin/ai/check',
  body: AiForm,
  response: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true) }),
    z.strictObject({
      ok: z.literal(false),
      code: AiProviderFailure,
      detail: z.string().optional(),
    }),
  ]),
} as const satisfies RouteDef;
