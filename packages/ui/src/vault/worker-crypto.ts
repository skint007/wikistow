import type { VaultCrypto } from '@wikistow/client';
import type { VaultRequest, VaultResponse } from './worker-protocol';

/** A vault step failed in the worker; `code` is the CryptoError code, if any. */
export class VaultWorkerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultWorkerError';
    this.code = code;
  }
}

type Op = keyof VaultCrypto;
type Result<K extends Op> = Awaited<ReturnType<VaultCrypto[K]>>;

function inWorker<K extends Op>(op: K, input: Parameters<VaultCrypto[K]>[0]): Promise<Result<K>> {
  const worker = new Worker(new URL('./vault.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Result<K>>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<VaultResponse>) => {
      const response = event.data;
      if ('ready' in response) {
        worker.postMessage({ op, input } satisfies { op: Op; input: VaultRequest['input'] });
        return;
      }
      // vault.worker.ts answers each operation with that operation's result;
      // the message channel itself carries no types.
      if (response.ok) resolve(response.result as Result<K>);
      else reject(new VaultWorkerError(response.code, response.message));
    };
    worker.onerror = () => reject(new VaultWorkerError('unexpected', 'The vault worker failed'));
  }).finally(() => worker.terminate());
}

/**
 * The vault's slow steps, each in its own worker so the page never freezes.
 * Results come back by structured clone, as plain objects and byte arrays.
 */
export const workerVaultCrypto: VaultCrypto = {
  create: (input) => inWorker('create', input),
  unlock: (input) => inWorker('unlock', input),
  changePassphrase: (input) => inWorker('changePassphrase', input),
};
