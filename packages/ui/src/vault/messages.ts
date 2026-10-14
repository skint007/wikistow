import { errorMessage } from '../errors';

/** What to say when a vault step fails. Settings are never weakened to make it work. */
export function vaultMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  switch (code) {
    case 'decrypt-failed':
      return 'That didn’t unlock the vault. Check it and try again.';
    case 'kdf-failed':
      return 'This device doesn’t have enough memory to unlock the vault. Try another device.';
    case 'malformed':
      return 'That doesn’t look like a recovery key. It has 64 characters in groups of four.';
    default:
      return errorMessage(error);
  }
}
