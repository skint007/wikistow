import {
  fingerprint,
  isUsableLabel,
  lookupPeople,
  normalizeEmail,
  pinLabel,
  type ClientContext,
  type ContactsPayloads,
  type DirectoryEntry,
  type Lookup,
  type PublicIdentity,
  type TrustStore,
} from '@wikistow/client';
import { peopleRoutes, type accountRoutes } from '@wikistow/contracts';
import { queryOptions } from '@tanstack/react-query';
import { PLAIN } from '../vault/store';

/** Someone a sharing dialog shows, named the way the protocol allows (section 8.2). */
export type Person = {
  id: string;
  /**
   * Their contact label, which the server can't change. For someone this
   * app hasn't pinned yet, the directory's name, marked `new`. Without a
   * usable one of either, the start of their key's fingerprint.
   */
  name: string;
  /**
   * Named by fingerprint: a pin with no usable label, or someone new whose
   * directory name can't be a label. They can't be chosen in a dialog.
   */
  nameless: boolean;
  email: string | null;
  self: boolean;
  /** As the directory lists them now, for sealing to them or confirming a key. */
  entry: Lookup | null;
  /**
   * `pinned`: their key is the one this app pinned. `new`: never seen.
   * `changed`: it differs from the pin, `pinnedKey` (section 8.4).
   * `declined`: a key the person declined. `missing`: the directory doesn't list them.
   */
  status: 'pinned' | 'new' | 'changed' | 'declined' | 'missing';
  pinnedKey: PublicIdentity | null;
  /** When this app pinned them, and whether that was a key someone checked or first sight. */
  pinned: { at: string; checked: boolean } | null;
  /**
   * Their avatar as the server has it, or null for initials. The server
   * chooses it, so it is decoration: nothing names or picks a person by it.
   */
  avatar: accountRoutes.AvatarId | null;
};

/** What naming someone reads from the session: whose it is, their contacts, and their pins. */
type Viewer = {
  identity: { public: { id: string } };
  contacts: { book: { payloads: ContactsPayloads } };
  trust: Pick<TrustStore, 'check'>;
};

// Someone shown by fingerprint, as section 8.2 asks when there is no usable name.
const byFingerprint = (identity: PublicIdentity) =>
  `Unnamed contact ${fingerprint(identity).slice(0, 14)}…`;

/**
 * How `entry` compares with this app's pins. A pinned person is named only
 * by their label, never by the directory; someone new by the directory's
 * name, if it could be their label. `foundBy` is the email the person
 * typed, or the one the list of people showed, when they found someone by
 * email: a label for that email naming another key is a key change too.
 */
export function describePerson(
  ctx: Viewer,
  id: string,
  entry: DirectoryEntry | null,
  foundBy: string | null = null,
): Person {
  const self = id === ctx.identity.public.id;
  const { shared, private: own } = ctx.contacts.book.payloads;
  const pin = shared.contacts.find((c) => c.identity.id === id) ?? null;
  const checked = entry ? ctx.trust.check(entry.identity, foundBy ?? undefined) : null;
  const pinnedKey =
    checked?.kind === 'changed'
      ? checked.pinned
      : checked?.kind === 'pinned'
        ? checked.identity
        : (pin?.identity ?? null);
  const label = pin ? pinLabel(pin, own.labels) : null;
  const listed =
    !pin &&
    entry &&
    isUsableLabel({ name: entry.name, email: normalizeEmail(foundBy ?? entry.email) })
      ? entry
      : null;
  const status: Person['status'] = !checked
    ? 'missing'
    : checked.kind === 'removed'
      ? 'declined'
      : checked.kind === 'unknown'
        ? 'new'
        : checked.kind;
  const shownKey = pin?.identity ?? entry?.identity ?? null;
  const name = self
    ? 'You'
    : (label?.name ??
      listed?.name ??
      (shownKey ? byFingerprint(shownKey) : 'Someone this app doesn’t know'));
  return {
    id,
    name,
    nameless: !self && !label && !listed,
    // A pin's email comes from its label too; the server's only for someone new.
    email: label?.email ?? foundBy ?? listed?.email ?? null,
    self,
    entry: entry && { ...entry, foundBy },
    status,
    pinnedKey,
    pinned: pin && { at: pin.verifiedAt, checked: pin.method === 'confirmed' },
    avatar: null,
  };
}

/**
 * The avatars of the people with these identity IDs, by ID. Avatars are
 * decoration, so a server that can't say (one from before avatars) leaves
 * everyone with initials rather than failing the list.
 */
async function avatarsOf(ctx: ClientContext, ids: readonly string[]) {
  const found = new Map<string, accountRoutes.AvatarId>();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const { avatars } = await ctx.api.call(peopleRoutes.avatars, {
        query: { ids: ids.slice(i, i + 100).join(',') },
      });
      for (const { identityId, avatar } of avatars) found.set(identityId, avatar);
    }
  } catch {
    return new Map<string, accountRoutes.AvatarId>();
  }
  return found;
}

/** The people with these identity IDs, by ID, as `describePerson` names them. */
export const peopleQuery = (ctx: ClientContext, ids: readonly string[]) => {
  const unique = [...new Set(ids)].sort();
  return queryOptions({
    queryKey: [PLAIN, 'people', ...unique],
    queryFn: async () => {
      const [entries, avatars] = await Promise.all([
        lookupPeople(ctx, unique),
        avatarsOf(ctx, unique),
      ]);
      const found = new Map<string, DirectoryEntry>(entries.map((e) => [e.identity.id, e]));
      return new Map(
        unique.map((id) => [
          id,
          { ...describePerson(ctx, id, found.get(id) ?? null), avatar: avatars.get(id) ?? null },
        ]),
      );
    },
  });
};
