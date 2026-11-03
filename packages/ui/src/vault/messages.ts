import { errorMessage } from '../errors';
import { KeptWrapperRefused } from './open';

// As "3 November".
const day = (date: Date) => date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });

/** What to say when a vault step fails. Settings are never weakened to make it work. */
export function vaultMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  switch (code) {
    case 'decrypt-failed':
      // Offline, against the wrapper kept at the last online unlock (ADR 0009, decision 5).
      return error instanceof KeptWrapperRefused
        ? `That didn’t unlock the vault. This device last unlocked online on ${day(error.keptAt)}. If you changed your passphrase since, use the one from before.`
        : 'That didn’t unlock the vault. Check it and try again.';
    case 'kdf-failed':
      return 'This device doesn’t have enough memory to unlock the vault. Try another device.';
    case 'malformed':
      return 'That doesn’t look like a recovery key. It has 64 characters in groups of four.';
    default:
      return errorMessage(error);
  }
}
