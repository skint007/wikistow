import { CryptoError } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';

const MESSAGES: Partial<Record<string, string>> = {
  'account-suspended': 'This account is suspended. Ask an administrator for help.',
  'email-unverified': 'Confirm your email address first. We sent you a link.',
  'registration-closed': 'Registration is closed. You need an invitation to join.',
  'invitation-not-found': 'This invitation link is not valid.',
  'invitation-used': 'This invitation has already been used.',
  'invitation-revoked': 'This invitation was withdrawn.',
  'invitation-expired': 'This invitation has expired. Ask for a new one.',
  'invitation-email-mismatch': 'This invitation is for a different email address.',
  'email-taken': 'An account with that email already exists.',
  'invitation-exists': 'That address already has a pending invitation.',
  'last-admin': 'There must always be at least one administrator.',
  'space-limit': 'Your account has made as many spaces as this server allows.',
  'folder-limit':
    'Your account has made as many folders as this server allows. Deleting folders it made frees room.',
  'page-limit':
    'Your account has made as many pages as this server allows. Deleting pages it made frees room.',
  'too-deep': 'Folders go at most 256 levels deep, so nothing was added there.',
  'cannot-target-self': 'You can’t do that to your own account.',
  'reauth-required': 'Sign in again to continue.',
  'wrong-password': 'That password is not right.',
  'wrong-code': 'That code didn’t work. Check it and try again.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
  'account-rate-limited': 'Too many attempts for this account. Wait a few minutes and try again.',
  'setup-link-invalid': 'This link has expired or was already used. Ask for a new one.',
  'handoff-invalid': 'This sign-in has expired. Start it again from the desktop app.',
  network: 'This app couldn’t reach the server. Check your connection and try again.',
  // Both locks last 15 minutes (TWO_FACTOR_LOCKOUT on the server).
  'two-factor-locked': 'Too many wrong codes. Wait 15 minutes and try again.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many wrong codes. Wait 15 minutes and try again.',
  INVALID_EMAIL_OR_PASSWORD: 'That email and password don’t match.',
  EMAIL_NOT_VERIFIED: 'Confirm your email address first. We sent you a new link.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Ask an administrator for help.',
  INVALID_CODE: 'That code didn’t work. Try the next one.',
  INVALID_TWO_FACTOR_COOKIE: 'Your sign-in expired. Start again.',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'Too many wrong codes for this sign-in. Start again.',
  INVALID_PASSWORD: 'That password is not right.',
};

// The server's answers in this app's words, since its own, when it sends
// any, are written for developers. Only for an ApiError: a CryptoError uses
// some of the same codes, such as key-version, for a stop that may mean an
// attack. Each request is all or nothing, so a refusal means nothing changed.
const SERVER: Partial<Record<ApiError['code'], string>> = {
  // The server says this both for what is gone and for what you can't see,
  // so neither gives the other away.
  'not-found': 'Something here was removed, or you can no longer see it.',
  forbidden: 'You don’t have permission to do that here.',
  'stale-head': 'Someone changed this while you were working, so nothing changed. Look again.',
  'permission-version': 'Who has access here changed meanwhile, so nothing changed. Try again.',
  'recipients-mismatch': 'The people with access changed meanwhile, so nothing changed. Try again.',
  'key-version': 'The keys here changed meanwhile, so nothing changed. Try again.',
  'region-mismatch': 'Something here moved meanwhile, so nothing changed. Try again.',
  'binding-mismatch':
    'The server turned this down as not matching where it goes, so nothing changed. Try again.',
  'payload-too-large': 'That’s too large for this server, so nothing changed.',
  'storage-full':
    'Your storage is full, so nothing changed. Free up some space, or ask your administrator for more.',
  'missing-blob': 'An attachment didn’t reach the server, so nothing changed. Try again.',
  'request-timeout': 'The server took too long, so nothing changed. Try again.',
  'vault-missing': 'This account has no vault yet. Reload to set one up.',
  'ai-off': 'AI isn’t set up on this server.',
  'vault-exists': 'This account set up its vault elsewhere meanwhile. Reload, then unlock it.',
  'stale-vault-version': 'Your vault changed elsewhere meanwhile, so nothing changed. Try again.',
  'unreadable-response': 'The server sent an answer this app can’t read. Try again in a moment.',
};

// What this app refused of what the server sent, before sending a write:
// the stops any write can meet, such as sharing a folder or saving a draft.
// Several mean the server may be misbehaving, and say so.
const STOPPED: Partial<Record<CryptoError['code'], string>> = {
  'unaccepted-owner':
    'This app hasn’t accepted every owner of this space, so it sealed nothing. If someone made you an owner, confirm who added you first; otherwise check the space’s owners.',
  'key-version':
    'The server offered an older key than this app has already seen. It may be hiding a change, so nothing was sent.',
  'region-mismatch':
    'The server put something where this app didn’t expect it, so nothing was sent. This could be an attack.',
  'untrusted-sealer':
    'Keys here came from someone this app doesn’t accept as an owner, so they weren’t used.',
  'missing-key': 'This app doesn’t hold every key it needs for this folder.',
  'unsupported-format':
    'Something here was saved by a newer version of WikiStow. Update the app, then try again.',
  'decrypt-failed':
    'Something here couldn’t be opened. It may have been changed on the server, so nothing was sent.',
  'bad-signature':
    'Something the server sent isn’t signed by who it says, so nothing was sent. This could be an attack.',
  'hash-mismatch':
    'Something the server sent was altered on the way, so nothing was sent. This could be an attack.',
  'key-commitment':
    'A key the server sent doesn’t match what it should open, so nothing was sent. This could be an attack.',
  'wrong-recipient':
    'A key the server sent was meant for someone else, so nothing was sent. This could be an attack.',
  'unknown-identity':
    'This app hasn’t seen the key of someone involved here, so it can’t check what they signed, and sent nothing.',
};

const GENERIC = 'Something went wrong. Try again.';

/**
 * This app's own message for an error code, or for an error carrying one
 * (as Better Auth's do); undefined when it has none.
 */
export function knownMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return MESSAGES[error];
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? MESSAGES[error.code] : undefined;
  }
  return undefined;
}

/** This app's own message for a write it stopped (a `CryptoError`); undefined when it has none. */
export const stopMessage = (error: unknown): string | undefined =>
  error instanceof CryptoError ? STOPPED[error.code] : undefined;

/** A short message for anything the API or Better Auth throws. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return SERVER[error.code] ?? MESSAGES[error.code] ?? error.message;
  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code && MESSAGES[code]) return MESSAGES[code];
    // Our own answers on /api/auth/* reach Better Auth's client as
    // { error: { code, message } }, one level down.
    const inner = 'error' in error ? error.error : undefined;
    if (typeof inner === 'object' && inner !== null && inner !== error) {
      const nested = errorMessage(inner);
      if (nested !== GENERIC) return nested;
    }
    if ('status' in error && error.status === 429) return MESSAGES['rate-limited'] ?? '';
    if ('message' in error && typeof error.message === 'string' && error.message)
      return error.message;
  }
  return GENERIC;
}

/**
 * A short message for a page that couldn't be opened. It reads the same
 * whether the page doesn't exist or wasn't shared, as the server's answer does.
 */
export const pageOpenMessage = (error: unknown): string =>
  error instanceof ApiError && error.code === 'not-found'
    ? 'This page doesn’t exist, or it hasn’t been shared with you.'
    : errorMessage(error);

/** Better Auth answers `{ data, error }`; turn its error into a thrown one. */
export function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error !== null && result.error !== undefined) throw result.error;
  if (result.data === null) throw new Error('Empty response');
  return result.data;
}
