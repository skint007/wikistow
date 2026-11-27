// Judging a vault that unlocked against the keys this device last unlocked
// with, and reading the directory's chain from them (section 4.6, **When
// someone else rotated**).
import { describe, expect, it } from 'vite-plus/test';
import {
  generateIdentity,
  IdentityId,
  InstallationId,
  keyHash,
  replaceKeysOperations,
  signIdentityRotation,
  type ApiClient,
  type PrivateIdentity,
} from '../src/index.ts';

const { checkKeys, judgeUnlock } = replaceKeysOperations;
const installationId = InstallationId.parse('replace-keys-installation');
const id = IdentityId.parse('replacing-person');
const keyAt = (keyVersion: number) => generateIdentity({ kind: 'human', id, keyVersion });
const [k1, k2, k3] = [keyAt(1), keyAt(2), keyAt(3)] as [
  PrivateIdentity,
  PrivateIdentity,
  PrivateIdentity,
];
const contacts = { version: 3, contactsHash: keyHash(k1.public) };
const s12 = signIdentityRotation({ installationId, from: k1, to: k2, contacts: null });
const s23 = signIdentityRotation({ installationId, from: k2, to: k3, contacts });
const vault = (identity: PrivateIdentity, retired: PrivateIdentity[] = []) => ({
  identity,
  retired,
});

describe('judgeUnlock', () => {
  it('takes the server’s word with nothing kept, or another person’s anchor', () => {
    expect(judgeUnlock(null, vault(k1))).toBe('ok');
    const someone = generateIdentity({ kind: 'human', id: IdentityId.parse('someone-else') });
    expect(judgeUnlock({ anchor: someone.public, successor: null }, vault(k1))).toBe('ok');
  });

  it('opens at the anchor, or at a later key whose keyring holds it', () => {
    const kept = { anchor: k1.public, successor: null };
    expect(judgeUnlock(kept, vault(k1))).toBe('ok');
    expect(judgeUnlock(kept, vault(k2, [k1]))).toBe('ok');
    expect(judgeUnlock(kept, vault(k3, [k1, k2]))).toBe('ok');
  });

  it('refuses older keys, or later ones that don’t hold the anchor', () => {
    expect(judgeUnlock({ anchor: k2.public, successor: null }, vault(k1))).toBe('rollback');
    const other = keyAt(2);
    expect(judgeUnlock({ anchor: k1.public, successor: null }, vault(other))).toBe('rollback');
    expect(judgeUnlock({ anchor: k2.public, successor: null }, vault(keyAt(2)))).toBe('rollback');
  });

  it('opens nothing older than a recorded successor, until the keyring is at it', () => {
    const kept = { anchor: k1.public, successor: k3.public };
    expect(judgeUnlock(kept, vault(k1))).toBe('replaced-elsewhere');
    expect(judgeUnlock(kept, vault(k2, [k1]))).toBe('replaced-elsewhere');
    expect(judgeUnlock(kept, vault(k3, [k1, k2]))).toBe('ok');
    // Another keyring at the successor's version isn't the successor.
    expect(judgeUnlock(kept, vault(keyAt(3), [k1, k2]))).toBe('rollback');
    // Past it, only through it.
    expect(judgeUnlock(kept, vault(keyAt(4), [k1, k2, k3]))).toBe('ok');
    expect(judgeUnlock(kept, vault(keyAt(4), [k1, k2, keyAt(3)]))).toBe('rollback');
  });
});

/** An API client answering the two public routes `checkKeys` reads. */
function serving(current: PrivateIdentity | null, rotations: unknown[]): ApiClient {
  return {
    call: async (route: { path: string }, input?: { query?: { from?: number } }) => {
      if (route.path === '/api/installation') return { installationId, publicRegistration: false };
      const from = input?.query?.from ?? 1;
      return {
        current: current?.public ?? null,
        rotations: rotations.filter(
          (s) => (s as { from: { keyVersion: number } }).from.keyVersion >= from,
        ),
      };
    },
  } as unknown as ApiClient;
}

describe('checkKeys', () => {
  it('says the anchor is still current', async () => {
    expect(await checkKeys(serving(k1, []), k1.public)).toEqual({ kind: 'same' });
  });

  it('follows a valid chain from the anchor', async () => {
    expect(await checkKeys(serving(k3, [s12, s23]), k1.public)).toEqual({
      kind: 'replaced',
      current: k3.public,
    });
    expect(await checkKeys(serving(k3, [s12, s23]), k2.public)).toEqual({
      kind: 'replaced',
      current: k3.public,
    });
  });

  it('calls anything else a substitution', async () => {
    // A gap, another key at a later version, an older key, and no key at all.
    expect(await checkKeys(serving(k3, [s23]), k1.public)).toEqual({ kind: 'substituted' });
    expect(await checkKeys(serving(keyAt(2), [s12]), k1.public)).toEqual({ kind: 'substituted' });
    expect(await checkKeys(serving(k1, [s12]), k2.public)).toEqual({ kind: 'substituted' });
    expect(await checkKeys(serving(null, []), k1.public)).toEqual({ kind: 'substituted' });
  });
});
