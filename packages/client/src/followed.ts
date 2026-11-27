// What a person's contacts record keeps about the rotations their app
// followed (protocol sections 4.6 and 8.4): the declines, which every device
// and agent obeys, and the follows the person hasn't seen the notice of yet.
import { Hash32, HumanId, PublicIdentity, Timestamp } from '@wikistow/contracts';
import { z } from 'zod';
import { CryptoError } from './errors.ts';

/** The shared payload's extension of declined rotations (section 8.4). */
export const DECLINED_NAMESPACE = 'wikistow.declined';

/** The private payload's extension of follows whose notice is still to be seen. */
export const FOLLOWED_NAMESPACE = 'wikistow.followed';

const DeclinedEntry = z.strictObject({ id: HumanId, keyHash: Hash32 });
export type DeclinedEntry = z.infer<typeof DeclinedEntry>;

// Parsed strictly: an entry this app can't read could be one that stops
// sealing, so the record is refused rather than read as having none.
const Declined = z.strictObject({ format: z.literal(1), entries: z.array(DeclinedEntry) });

/**
 * A pin as the record held it: the key a follow started from, which
 * declining restores with its `method` and `verifiedAt`.
 */
const FollowedFrom = z.looseObject({
  identity: PublicIdentity.extend({ id: HumanId, kind: z.literal('human') }),
  verifiedAt: Timestamp,
  method: z.enum(['first-seen', 'confirmed']),
});

const FollowedEntry = z.looseObject({
  /** The pin before the earliest follow the person hasn't seen or declined. */
  from: FollowedFrom,
  /** The key followed to, now the pin. */
  to: z.looseObject({ id: HumanId, keyHash: Hash32, keyVersion: z.number().int().positive() }),
});
export type FollowedEntry = z.infer<typeof FollowedEntry>;

const Followed = z.looseObject({ entries: z.array(FollowedEntry) });

const key = (entry: { id: string; keyHash: string }) => `${entry.id} ${entry.keyHash}`;

/**
 * The declined rotations of a shared payload's extensions: none when absent.
 * One that doesn't parse fails closed (`malformed`), as the record may also
 * have been written with a leaked key, and the app asks to update.
 */
export function declinedIn(extensions: Record<string, unknown>): DeclinedEntry[] {
  if (!Object.hasOwn(extensions, DECLINED_NAMESPACE)) return [];
  const parsed = Declined.safeParse(extensions[DECLINED_NAMESPACE]);
  if (!parsed.success) {
    throw new CryptoError(
      'malformed',
      'The contacts record holds declined keys this app can’t read; update the app. It may also have been written with a leaked key.',
    );
  }
  return parsed.data.entries;
}

/** The extensions with `entries` as the declined rotations: a sorted set, dropped when empty. */
export function withDeclined(
  extensions: Record<string, unknown>,
  entries: readonly DeclinedEntry[],
): Record<string, unknown> {
  const { [DECLINED_NAMESPACE]: _gone, ...rest } = extensions;
  const unique = [...new Map(entries.map((entry) => [key(entry), entry])).values()].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  return unique.length === 0
    ? rest
    : { ...rest, [DECLINED_NAMESPACE]: { format: 1, entries: unique } };
}

/**
 * The follows in a private payload's extensions whose notice the person
 * hasn't seen. An entry this app can't read is skipped, and kept when
 * writing (`withFollowed`): at worst a notice doesn't show.
 */
export function followedIn(extensions: Record<string, unknown>): FollowedEntry[] {
  return storedEntries(extensions).flatMap((entry) => {
    const parsed = FollowedEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

// The extension's entries as stored, read or not.
function storedEntries(extensions: Record<string, unknown>): unknown[] {
  const raw = extensions[FOLLOWED_NAMESPACE];
  const entries = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'entries') : null;
  return Array.isArray(entries) ? entries : [];
}

/** The extensions with the follows of `id` replaced by `entry`, or dropped when it is null. */
export function withFollowed(
  extensions: Record<string, unknown>,
  id: string,
  entry: FollowedEntry | null,
): Record<string, unknown> {
  const kept = storedEntries(extensions).filter((held) => {
    const parsed = FollowedEntry.safeParse(held);
    return !parsed.success || parsed.data.from.identity.id !== id;
  });
  const entries = [...kept, ...(entry ? [entry] : [])];
  const { [FOLLOWED_NAMESPACE]: stored, ...rest } = extensions;
  const others = Followed.safeParse(stored);
  return entries.length === 0
    ? rest
    : { ...rest, [FOLLOWED_NAMESPACE]: { ...(others.success ? others.data : {}), entries } };
}
