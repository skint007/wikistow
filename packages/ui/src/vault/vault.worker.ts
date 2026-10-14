// Runs the vault's Argon2id steps off the page's thread. One worker per
// operation; the page terminates it as soon as the answer arrives.
import { CryptoError, inlineVaultCrypto } from '@wikistow/client';
import type { VaultRequest, VaultResponse } from './worker-protocol';

async function run(request: VaultRequest) {
  switch (request.op) {
    case 'create':
      return inlineVaultCrypto.create(request.input);
    case 'unlock':
      return inlineVaultCrypto.unlock(request.input);
    case 'changePassphrase':
      return inlineVaultCrypto.changePassphrase(request.input);
    default:
      throw new Error(`Unknown vault operation: ${JSON.stringify(request satisfies never)}`);
  }
}

self.onmessage = (event: MessageEvent<VaultRequest>) => {
  run(event.data).then(
    (result) => self.postMessage({ ok: true, result } satisfies VaultResponse),
    (error: unknown) =>
      self.postMessage({
        ok: false,
        code: error instanceof CryptoError ? error.code : 'unexpected',
        message: error instanceof Error ? error.message : 'Vault operation failed',
      } satisfies VaultResponse),
  );
};

// Module workers run this only after every import has loaded, so the page
// can now post its request without it arriving before the listener exists.
self.postMessage({ ready: true } satisfies VaultResponse);
