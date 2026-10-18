import { z } from 'zod';
import { PublicIdentity } from '../records/identity.ts';
import { isPlainText } from '../records/text.ts';
import type { RouteDef } from '../route.ts';

export const Email = z.email().max(254);
/** Long passphrases welcome; the floor matches Better Auth's configuration. */
export const Password = z.string().min(12).max(256);
/**
 * The name other people see when they look someone up. It refuses the
 * controls that could reorder or hide the text around it in their dialogs
 * (protocol section 3.3). No two accounts on a server share one, with case
 * and spacing ignored (`name-taken`).
 */
export const DisplayName = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(100, 'Use at most 100 characters')
  .refine(isPlainText, 'A name can’t hold control or text-direction characters');
/** Invitation tokens are 32 random bytes, base64url. */
export const InvitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const THEMES = ['system', 'light', 'slate', 'warm', 'oled'] as const;
export const Theme = z.enum(THEMES);
export const Role = z.enum(['user', 'admin']);

/**
 * Create an account, with an invitation token or, when an administrator has
 * opened registration, without one. An email-bound invitation carries the
 * person's name and password, and the account then confirms its email. Open
 * registration and generic links take the address alone: the mailbox owner
 * chooses the name and password from the emailed link (`finishAccountSetup`).
 */
export const createAccount = {
  method: 'POST',
  path: '/api/accounts',
  body: z.object({
    token: InvitationToken.optional(),
    email: Email,
    /** Required with an email-bound invitation, and ignored otherwise. */
    name: DisplayName.optional(),
    password: Password.optional(),
  }),
  /**
   * Only email-bound invitation holders get the new account's ID. Generic links
   * and open registration return the same body for new and taken addresses,
   * and a generic link is used up either way.
   */
  response: z.object({ accountId: z.uuid().optional() }),
  status: 201,
} as const satisfies RouteDef;

/**
 * Create a new server's first account, its administrator, while it has no
 * accounts (`installation.setup`). Its address counts as verified, so it
 * signs in at once. Refused with `admin-exists` once any account exists.
 */
export const createFirstAccount = {
  method: 'POST',
  path: '/api/setup',
  body: z.object({ name: DisplayName, email: Email, password: Password }),
  response: z.object({}),
  status: 201,
} as const satisfies RouteDef;

/** Setup link tokens are 32 random bytes, base64url, like invitation tokens. */
export const SetupToken = InvitationToken;

/**
 * Finish an account from the link mailed to its address: the owner's name and
 * first password. That confirms the address too. The person then signs in.
 */
export const finishAccountSetup = {
  method: 'POST',
  path: '/api/accounts/setup',
  body: z.object({ token: SetupToken, name: DisplayName, password: Password }),
  response: z.object({}),
} as const satisfies RouteDef;

/** What the invite page shows before the form. Tokens travel in the body, never the URL. */
export const inspectInvitation = {
  method: 'POST',
  path: '/api/invitations/inspect',
  body: z.object({ token: InvitationToken }),
  response: z.discriminatedUnion('status', [
    z.object({ status: z.literal('valid'), email: Email.nullable(), expiresAt: z.iso.datetime() }),
    z.object({ status: z.enum(['expired', 'used', 'revoked', 'not-found']) }),
  ]),
} as const satisfies RouteDef;

/**
 * An avatar's random name, new with every upload. Avatars aren't encrypted:
 * anyone with the name may fetch the image (`AVATAR_PATH`), so the name is
 * only given to the account and to people the directory shows it to.
 */
export const AvatarId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export type AvatarId = z.infer<typeof AvatarId>;

/** The largest avatar the server takes: 2 MiB. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Avatar bytes aren't JSON, so these two are registered as binary routes:
 * PUT `/api/me/avatar` with the image, answered with `AvatarUpload`, and GET
 * `/api/avatars/:avatarId` for it back, which needs no session.
 */
export const AVATAR_UPLOAD_PATH = '/api/me/avatar';
export const AVATAR_PATH = '/api/avatars/:avatarId';
export const AvatarUpload = z.object({ avatar: AvatarId });

/** Where the browser loads an avatar from. */
export const avatarUrl = (avatar: AvatarId) => `/api/avatars/${avatar}`;

/** Remove the signed-in account's avatar. Its initials show again. */
export const removeAvatar = {
  method: 'DELETE',
  path: AVATAR_UPLOAD_PATH,
  response: z.object({}),
} as const satisfies RouteDef;

export const me = {
  method: 'GET',
  path: '/api/me',
  response: z.object({
    account: z.object({
      id: z.uuid(),
      email: Email,
      name: z.string(),
      role: Role,
      theme: Theme,
      /** Null when the account shows its initials, as with servers from before avatars. */
      avatar: AvatarId.nullable().default(null),
    }),
    session: z.object({ createdAt: z.iso.datetime() }),
    /** Null until the account has set up its vault. */
    identity: PublicIdentity.nullable(),
  }),
} as const satisfies RouteDef;

/**
 * Confirm it's still you, for changes that need a recent sign-in: the
 * password, then a code when two-factor is on. The current session is marked
 * as a recent sign-in in place, so nothing signs the browser out on the way
 * and giving up leaves it signed in as before. Sent with the password alone,
 * it answers `code-required` when a code is needed too.
 */
export const reauthenticate = {
  method: 'POST',
  path: '/api/me/reauth',
  body: z.object({
    password: z.string().min(1).max(256),
    code: z
      .object({ kind: z.enum(['totp', 'backup']), value: z.string().trim().min(1).max(64) })
      .optional(),
  }),
  response: z.object({ status: z.enum(['confirmed', 'code-required']) }),
} as const satisfies RouteDef;

/**
 * Ask to move the signed-in account to another address. It needs a recent
 * sign-in (`reauthenticate`). A link goes to the new address, and nothing
 * changes until it is opened (`confirmEmailChange`), so the current address
 * keeps working. The answer is the same whether another account has the new
 * address or not.
 */
export const requestEmailChange = {
  method: 'POST',
  path: '/api/me/email',
  body: z.object({ email: Email }),
  response: z.object({}),
} as const satisfies RouteDef;

/** Email change link tokens are 32 random bytes, base64url, like invitation tokens. */
export const EmailChangeToken = InvitationToken;

/**
 * Open the link mailed to the new address: the account signs in with it from
 * then on, and the old address hears of it. The link works once. Answers
 * `email-link-invalid` for a used or expired link, and `email-taken`, changing
 * nothing, when another account has the address by then.
 */
export const confirmEmailChange = {
  method: 'POST',
  path: '/api/accounts/email/confirm',
  body: z.object({ token: EmailChangeToken }),
  response: z.object({ email: Email }),
} as const satisfies RouteDef;

/**
 * Change the signed-in account's name. People who already have the account
 * as a contact keep their own name for it (protocol section 8.2). Answers
 * `name-taken` when another account uses the name.
 */
export const setName = {
  method: 'PUT',
  path: '/api/me/name',
  body: z.object({ name: DisplayName }),
  response: z.object({ name: z.string() }),
} as const satisfies RouteDef;

export const setTheme = {
  method: 'PUT',
  path: '/api/me/theme',
  body: z.object({ theme: Theme }),
  response: z.object({ theme: Theme }),
} as const satisfies RouteDef;
