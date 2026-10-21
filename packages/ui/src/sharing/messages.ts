import { CryptoError } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { knownMessage, stopMessage } from '../errors';

// The server's refusals of an owner action. Every sharing request is all or
// nothing, so a refusal always means nothing changed.
const REFUSED: Partial<Record<ApiError['code'], string>> = {
  'request-timeout': 'The server took too long, so nothing changed. Try again.',
  'rate-limited': 'Too many lookups for now. Wait a minute and try again.',
  'stale-head': 'Someone changed who has access meanwhile. Check the list again.',
  'key-version': 'Someone changed this folder’s keys meanwhile. Try again.',
  'permission-version': 'Access changed while you were working. Try again.',
  'recipients-mismatch': 'The people with access changed meanwhile. Try again.',
  'region-mismatch': 'Something here moved while you were working, so nothing changed. Try again.',
  'share-nesting':
    'Shares don’t nest: this folder is inside a shared folder, or a folder inside it is shared.',
  'last-owner': 'A space always keeps one owner. Add another owner first.',
  'home-space': 'This is an owner’s home space, so it can’t be deleted.',
  duplicate: 'That was already done. Close this and look again.',
  'not-found': 'That person or folder isn’t there any more.',
  'payload-too-large': 'This folder is too big to share in one go.',
  'storage-full':
    'Your storage is full, so nothing was shared. Free up some space, or ask your administrator for more.',
  forbidden: 'Only an owner of this space can do that.',
  unauthenticated: 'You’ve been signed out. Sign in again, then try again.',
  'contacts-invalid': 'The server turned down the update to your contacts, so nothing was shared.',
  'bad-signature':
    'The server turned down a signature this app made, so nothing changed. If it keeps happening, update the app.',
  'binding-mismatch':
    'The server turned down a record as not matching where it goes, so nothing changed. Try again.',
  'invalid-request':
    'The server didn’t understand the request, so nothing changed. Update the app and try again.',
  'missing-blob': 'An attachment here is missing on the server, so nothing was shared.',
  'blob-label-mismatch': 'An attachment here is missing on the server, so nothing was shared.',
  internal: 'The server ran into a problem, so nothing changed. Try again in a moment.',
  network:
    'This app couldn’t reach the server, so nothing changed. Check your connection and try again.',
  'unreadable-response':
    'The server’s answer didn’t make sense, so this app can’t tell whether it went through. Close this and look again.',
};

// What the server sent this app that it may not be telling straight. The
// contacts record is where this app keeps who is who, so a stale or forked
// one is the clearest sign of a server misbehaving.
const MISBEHAVING = 'The server may be misbehaving or under attack, so nothing was shared.';

// What this app refused before sending a sharing change, beyond the stops
// any write can meet (`stopMessage`).
const STOPPED: Partial<Record<CryptoError['code'], string>> = {
  'identity-key-changed':
    'Someone’s key changed since this app last saw it. Review the change before sharing with them.',
  'binding-mismatch':
    'What the server sent doesn’t match what you were shown, so nothing was shared. This could be an attack.',
  'contacts-unconfirmed':
    'Your contacts couldn’t be saved, so nothing was shared. Check your connection and try again.',
  'contacts-conflict':
    'Another of your devices saw this person with a different key. Review it before going on.',
  'contacts-rollback': `${MISBEHAVING} It sent an older copy of your contacts than this app has already seen. Try again later, and if it keeps happening, tell whoever runs your server.`,
  'contacts-fork': `${MISBEHAVING} It sent a copy of your contacts that doesn’t follow on from the one this app saw. Don’t share from this device until whoever runs your server has looked into it.`,
  'bad-key': 'Someone involved has a key this app can’t use, so nothing was shared with them.',
  'fingerprint-mismatch': 'The fingerprints don’t match, so nothing changed.',
  malformed:
    'Something involved isn’t in a form this app accepts, such as an account with no usable name, so nothing changed.',
};

const GENERIC = 'Something went wrong, so nothing changed. Try again.';

/**
 * A short message for a failed sharing or ownership action: always this
 * app's own words, never the server's or an exception's.
 */
export function sharingMessage(error: unknown): string {
  if (error instanceof ApiError) return REFUSED[error.code] ?? knownMessage(error.code) ?? GENERIC;
  if (error instanceof CryptoError) return STOPPED[error.code] ?? stopMessage(error) ?? GENERIC;
  return knownMessage(error) ?? GENERIC;
}

/** Whether `error` means someone else changed access first, so the plan should be made again. */
export const isStale = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === 'stale-head' ||
    error.code === 'key-version' ||
    error.code === 'permission-version');
