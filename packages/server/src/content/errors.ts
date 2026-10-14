import type { ErrorDetail } from '@wikistow/contracts';

/** Why a content operation was refused. Route handlers map these to API errors. */
export type ContentFailure =
  | 'not-found'
  | 'forbidden'
  | 'vault-missing'
  | 'vault-exists'
  | 'vault-immutable-field'
  | 'stale-vault-version'
  | 'invalid-vault'
  | 'binding-mismatch'
  | 'bad-signature'
  | 'recipients-mismatch'
  | 'stale-head'
  | 'enrollment-state'
  | 'permission-version'
  | 'duplicate'
  | 'missing-blob'
  | 'blob-label-mismatch'
  | 'too-large'
  | 'storage-full'
  | 'busy'
  | 'contacts-invalid'
  | 'region-mismatch'
  | 'key-version'
  | 'share-nesting'
  | 'too-deep'
  | 'space-limit'
  | 'folder-limit'
  | 'page-limit'
  | 'last-owner';

export class ContentError extends Error {
  readonly code: ContentFailure;
  /** IDs and numbers a refusal carries for the client. */
  readonly detail: ErrorDetail;

  constructor(code: ContentFailure, message: string = code, detail: ErrorDetail = {}) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
    this.detail = detail;
  }
}
