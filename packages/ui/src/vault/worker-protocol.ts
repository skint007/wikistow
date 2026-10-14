import type { VaultCrypto } from '@wikistow/client';

type Op = keyof VaultCrypto;

/** One vault operation, posted to a fresh worker. */
export type VaultRequest = {
  [K in Op]: { op: K; input: Parameters<VaultCrypto[K]>[0] };
}[Op];

export type VaultResponse =
  /**
   * Sent once the worker's modules (libsodium included) have loaded. A
   * request posted before then could arrive before anything listens for it.
   */
  | { ready: true }
  | { ok: true; result: Awaited<ReturnType<VaultCrypto[Op]>> }
  | { ok: false; code: string; message: string };
