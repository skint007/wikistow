import { generateIdentity, IdentityId, InstallationId } from '@wikistow/client';
import { FAST_KDF } from '@wikistow/client/testing';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  createKeyFile,
  openKeyFile,
  withoutSecretStore,
  withSecretStore,
  type Secrets,
} from '../src/keyfile.ts';

const installationId = InstallationId.parse('installation-a');
const person = generateIdentity({ kind: 'human', id: IdentityId.parse('person-a') });
const agent = generateIdentity({ kind: 'agent', installationId, ownerId: person.public.id });
const TOKEN = `wsa_${'A'.repeat(22)}.${'B'.repeat(43)}`;
const PASSPHRASE = 'key file passphrase';

const secrets = (): Secrets => ({
  installationId,
  identity: agent,
  person: person.public,
  token: TOKEN,
  stateKey: randomBytes(32),
});

const made = () =>
  createKeyFile({
    server: 'https://wiki.example',
    secrets: secrets(),
    passphrase: PASSPHRASE,
    kdf: FAST_KDF,
  });

const code = (expected: string) => expect.objectContaining({ code: expected });

describe('the key file', () => {
  it('opens with a secret store’s secret once one is configured, and not after', () => {
    const file = made();
    const { dataKey } = openKeyFile(file, { kind: 'passphrase', passphrase: PASSPHRASE });
    const secret = randomBytes(32);
    const store = { tool: '/usr/bin/secret-tool', service: 'wikistow' as const, account: 'acct' };
    const stored = withSecretStore(file, dataKey, store, secret);
    expect(openKeyFile(stored, { kind: 'secret-store', secret }).secrets.token).toBe(TOKEN);
    // The passphrase still works, and once removed the store opens nothing.
    expect(openKeyFile(stored, { kind: 'passphrase', passphrase: PASSPHRASE }).secrets.token).toBe(
      TOKEN,
    );
    expect(() => openKeyFile(withoutSecretStore(stored), { kind: 'secret-store', secret })).toThrow(
      code('locked'),
    );
  });
});
