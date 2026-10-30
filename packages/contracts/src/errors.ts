import { z } from 'zod';

/** Every error code the API returns. Clients branch on `code`, never on the message. */
export const ERROR_STATUS = {
  'invalid-request': 400,
  'binding-mismatch': 400,
  'wrong-password': 400,
  'wrong-code': 400,
  unauthenticated: 401,
  forbidden: 403,
  'account-suspended': 403,
  'email-unverified': 403,
  'registration-closed': 403,
  'reauth-required': 403,
  'not-found': 404,
  'ai-off': 404,
  'vault-missing': 404,
  'invitation-not-found': 404,
  'invitation-used': 409,
  'invitation-revoked': 409,
  'email-taken': 409,
  'name-taken': 409,
  'invitation-exists': 409,
  'admin-exists': 409,
  'last-admin': 409,
  'cannot-target-self': 409,
  'vault-exists': 409,
  'stale-vault-version': 409,
  'stale-head': 409,
  'enrollment-state': 409,
  'permission-version': 409,
  'key-version': 409,
  'region-mismatch': 409,
  'share-nesting': 409,
  'too-deep': 409,
  'space-limit': 409,
  'folder-limit': 409,
  'page-limit': 409,
  'draft-limit': 409,
  'last-owner': 409,
  'home-space': 409,
  'mail-off': 409,
  duplicate: 409,
  'request-timeout': 408,
  'invitation-expired': 410,
  'setup-link-invalid': 410,
  'email-link-invalid': 410,
  'handoff-invalid': 410,
  'payload-too-large': 413,
  'unsupported-image': 415,
  'invitation-email-mismatch': 422,
  'vault-immutable-field': 422,
  'bad-signature': 422,
  'contacts-invalid': 422,
  'recipients-mismatch': 422,
  'missing-blob': 422,
  'mail-failed': 422,
  'blob-label-mismatch': 422,
  'storage-full': 413,
  'rate-limited': 429,
  'account-rate-limited': 429,
  'two-factor-locked': 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);

export const ErrorCode = z.custom<ErrorCode>(isErrorCode, 'Unknown error code');

/**
 * IDs and numbers a refusal carries, never content: the share's current key
 * version for `key-version`, the share in the way for `share-nesting`,
 * for an editor's `stale-head` on a page, its current heads, for a
 * move's `stale-head` because the node moved, where it is now, for a
 * copy's `stale-head` at its finish, the new nodes whose sources changed,
 * or for a copy refused at its opening for a live publication, its pages.
 */
export const ErrorDetail = z.object({
  keyVersion: z.number().int().optional(),
  shareId: z.string().optional(),
  draftHead: z.string().nullable().optional(),
  publishedHead: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  nodeIds: z.array(z.string()).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    /** Field paths for `invalid-request`. Never contains submitted values. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** What a refusal can name besides its code, so the client knows what to fetch again. */
    detail: ErrorDetail.optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
