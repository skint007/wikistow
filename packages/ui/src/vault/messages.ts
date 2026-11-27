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
    case 'unsupported-format':
      // As after someone replaced their keys with a newer app (section 4.6).
      return 'Your vault was saved by a newer version of WikiStow. Update the app to unlock it.';
    case 'keys-replaced-elsewhere':
      return 'Your keys were replaced since this device last unlocked. Unlock with the new passphrase, online.';
    case 'keys-rollback':
      // Neither the keys this device last unlocked with, nor keys that follow from them.
      return 'This vault holds older keys than the ones this device last unlocked with, or keys that don’t follow from them. That may be an attack: don’t unlock here, and tell whoever runs your server.';
    case 'malformed':
      return 'That doesn’t look like a recovery key. It has 64 characters in groups of four.';
    default:
      return errorMessage(error);
  }
}
