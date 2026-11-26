import { CryptoError } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { vaultMessage } from '../src/vault/messages.ts';
import { noLongerOpens } from '../src/vault/open.ts';

describe('a vault in a format this version doesn’t unlock', () => {
  const newer = new CryptoError('unsupported-format', 'This vault is in a newer format');

  it('asks to update the app, from the worker too', () => {
    const update =
      'Your vault was saved by a newer version of WikiStow. Update the app to unlock it.';
    expect(vaultMessage(newer)).toBe(update);
    // From the worker, the error keeps its code but not its class.
    expect(vaultMessage({ code: 'unsupported-format', message: 'x' })).toBe(update);
  });

  it('keeps a remembered unlock, which says nothing about its key', () => {
    expect(noLongerOpens(newer)).toBe(false);
    expect(noLongerOpens(new CryptoError('decrypt-failed', 'wrong key'))).toBe(true);
    expect(noLongerOpens(new Error('offline'))).toBe(false);
  });
});
