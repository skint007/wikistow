/** Why an account operation was refused. Route handlers map these to API errors. */
export type AccountFailure =
  | 'registration-closed'
  | 'invitation-not-found'
  | 'invitation-used'
  | 'invitation-revoked'
  | 'invitation-expired'
  | 'invitation-email-mismatch'
  | 'invitation-exists'
  | 'email-taken'
  | 'admin-exists'
  | 'account-not-found'
  | 'not-admin'
  | 'cannot-target-self'
  | 'last-admin'
  | 'details-required'
  | 'setup-link-invalid'
  | 'email-link-invalid';

export class AccountError extends Error {
  readonly code: AccountFailure;

  constructor(code: AccountFailure) {
    super(code);
    this.name = 'AccountError';
    this.code = code;
  }
}
