import { DEFAULT_KDF } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../src/config.ts';

const valid = {
  DATABASE_URL: 'postgres://u:p@db:5432/wikistow',
  PUBLIC_ORIGIN: 'https://wiki.example/some/path',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  SMTP_URL: 'smtp://relay:587',
  SMTP_FROM: 'WikiStow <wiki@example.test>',
  BLOB_DIR: '/data/blobs',
};

describe('loadConfig', () => {
  it('keeps proxy trust and rate limiting safe by default', () => {
    expect(loadConfig(valid)).toMatchObject({ trustProxy: false, rateLimit: true });
    // Vault passphrase wrappers must cost at least what the client uses by default.
    expect(loadConfig(valid).minKdf).toEqual(DEFAULT_KDF);
  });

  it('lets people replace their identity keys unless it is turned off', () => {
    expect(loadConfig(valid).identityRotation).toBe(true);
    expect(loadConfig({ ...valid, IDENTITY_ROTATION: 'off' }).identityRotation).toBe(false);
    expect(() => loadConfig({ ...valid, IDENTITY_ROTATION: 'yes' })).toThrow(/IDENTITY_ROTATION/);
  });
});
