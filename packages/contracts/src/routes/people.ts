import { z } from 'zod';
import { AgentEnrollment } from '../records/agent.ts';
import { PublicIdentity } from '../records/identity.ts';
import { IdentityId } from '../records/ids.ts';
import type { RouteDef } from '../route.ts';
import { AvatarId } from './accounts.ts';

/**
 * A person as the directory lists them: their current key, and the display
 * name and email the server shows. Untrusted: an app checks the key against
 * its pins, and uses the name and email only to label a key it sees for the
 * first time (protocol sections 8.2 and 8.3).
 */
export const DirectoryPerson = z.strictObject({
  identity: PublicIdentity,
  name: z.string(),
  email: z.string(),
});
export type DirectoryPerson = z.infer<typeof DirectoryPerson>;

/**
 * An agent as the directory lists it: the enrollment its person signed,
 * which apps check against their pin of that person, and the name its
 * person gave it, as the server has it (untrusted). Revoked agents are
 * listed too, so what they wrote stays readable.
 */
export const DirectoryAgent = z.strictObject({
  enrollment: AgentEnrollment,
  name: z.string(),
});
export type DirectoryAgent = z.infer<typeof DirectoryAgent>;

/**
 * People by identity ID, comma-separated: the caller, and anyone who owns,
 * holds keys in, or wrote or signed something in a space the caller owns or
 * holds keys in. Others are left out. Agents among the IDs that wrote
 * something there come in `agents`, and their people in `people`. An agent
 * asking gets its person, and the authors in the shares it is granted.
 */
export const directory = {
  method: 'GET',
  path: '/api/directory',
  query: z.object({
    ids: z
      .string()
      .transform((ids) => ids.split(',').filter(Boolean))
      .pipe(z.array(IdentityId).max(100)),
  }),
  response: z.strictObject({
    people: z.array(DirectoryPerson),
    agents: z.array(DirectoryAgent),
  }),
} as const satisfies RouteDef;

/**
 * The avatars of the people `directory` would list for these identity IDs.
 * People without one are left out. Separate from the directory, whose
 * answer older apps read strictly.
 */
export const avatars = {
  method: 'GET',
  path: '/api/directory/avatars',
  query: directory.query,
  response: z.object({
    avatars: z.array(z.object({ identityId: IdentityId, avatar: AvatarId })),
  }),
} as const satisfies RouteDef;

/**
 * The person with exactly this email, once normalized (section 3.2), if
 * their account has a vault. Nothing for a partial match. Rate-limited. The
 * email travels in the body, so it never lands in a request log.
 */
export const lookupPerson = {
  method: 'POST',
  path: '/api/people/lookup',
  body: z.object({ email: z.string().max(320) }),
  response: z.strictObject({ person: DirectoryPerson.nullable() }),
} as const satisfies RouteDef;

/**
 * Everyone `lookupPerson` could find, for a person to pick from when they
 * share (protocol section 7.3): the accounts with a vault, but not the
 * caller. `withoutVault` names the accounts that have none yet, which can't
 * be picked. Humans with a vault only. Rate-limited.
 */
export const listPeople = {
  method: 'GET',
  path: '/api/people',
  response: z.strictObject({
    people: z.array(DirectoryPerson),
    withoutVault: z.array(z.strictObject({ name: z.string(), email: z.string() })),
  }),
} as const satisfies RouteDef;
