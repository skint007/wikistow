import {
  AccountId,
  CryptoError,
  FolderKeyring,
  generateIdentity,
  IdentityId,
  newId,
  RevisionCache,
  type ClientContext,
  type UnlockedVault,
} from '@wikistow/client';
import { describe, expect, it, vi } from 'vite-plus/test';
import { vaultMessage } from '../src/vault/messages.ts';
import { noLongerOpens } from '../src/vault/open.ts';
import { vaultStore } from '../src/vault/store.ts';
import { forgetInTab as forgetInTabMock } from '../src/vault/tab-unlock.ts';

vi.mock('../src/vault/tab-unlock.ts', async (original) => ({
  ...(await original<typeof import('../src/vault/tab-unlock.ts')>()),
  forgetInTab: vi.fn(() => Promise.resolve()),
  rememberInTab: vi.fn(() => Promise.resolve()),
}));
const forgetInTab = vi.mocked(forgetInTabMock);

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

describe('locking for a vault this version doesn’t unlock', () => {
  const vault = (): UnlockedVault => ({
    accountId: AccountId.parse('account-1'),
    identity: generateIdentity({ kind: 'human', id: newId(IdentityId), keyVersion: 2 }),
    retired: [generateIdentity({ kind: 'human', id: newId(IdentityId) })],
    vaultKey: new Uint8Array(32).fill(7),
  });

  // Locking closes the session: only its folder keys and caches are read.
  const session = () =>
    ({
      keyring: new FolderKeyring(),
      revisions: new RevisionCache(),
      spaces: new Map(),
    }) as unknown as ClientContext;

  it('keeps the remembered unlock only when asked, and zeroes every key', () => {
    forgetInTab.mockClear();
    const kept = vault();
    vaultStore.unlock(session(), kept);
    vaultStore.lock({ forget: false });
    expect(forgetInTab).not.toHaveBeenCalled();
    expect(kept.retired[0]?.signSecretKey.every((byte) => byte === 0)).toBe(true);
    vaultStore.unlock(session(), vault());
    vaultStore.lock();
    expect(forgetInTab).toHaveBeenCalledOnce();
  });
});
