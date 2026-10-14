import { z } from 'zod';
import { SealedContacts, SignedContactsRecord } from '../records/contacts.ts';
import { PositiveInt } from '../records/encoding.ts';
import type { RouteDef } from '../route.ts';

/**
 * The caller's contacts record (protocol section 8), or `null` before
 * their first write. With `after=n`, also every later version's signed
 * record, oldest first, so a device can check the chain from version `n`.
 */
export const getContacts = {
  method: 'GET',
  path: '/api/me/contacts',
  query: z.object({ after: z.coerce.number().int().min(0).optional() }),
  response: z.strictObject({
    record: SealedContacts.nullable(),
    chain: z.array(SignedContactsRecord),
  }),
} as const satisfies RouteDef;

/**
 * Store the next version, only if the current one is still `expectedVersion`
 * (0 for none): a compare-and-swap. Otherwise `stale-head`; fetch the newer
 * record, re-apply the changes, and try again.
 */
export const putContacts = {
  method: 'PUT',
  path: '/api/me/contacts',
  body: z.object({
    expectedVersion: z.number().int().min(0),
    record: SealedContacts,
  }),
  response: z.strictObject({ version: PositiveInt }),
} as const satisfies RouteDef;
