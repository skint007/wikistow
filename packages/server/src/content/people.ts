// The directory people are found in (protocol sections 7.3 and 8.3). It is
// untrusted: apps check every key against their pins, and use a name and
// email only to label a key they see for the first time.
import { AgentEnrollment, PublicIdentity } from '@wikistow/contracts';
import { normalizeEmail } from '@wikistow/client';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { agentGrants, shares } from '../db/schema/index.ts';
import { personAccess, subtreeOf } from './access.ts';
import { requireCaller, type Actor, type Caller } from './identities.ts';
import { requireIdentity } from './structure.ts';

type PersonRow = {
  id: string;
  kind: 'human' | 'agent';
  key_version: number;
  box_public_key: string;
  sign_public_key: string;
  name: string;
  email: string;
};

const idList = (ids: readonly string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;

const toPerson = (row: PersonRow) => ({
  identity: PublicIdentity.parse({
    id: row.id,
    kind: row.kind,
    keyVersion: row.key_version,
    boxPublicKey: row.box_public_key,
    signPublicKey: row.sign_public_key,
  }),
  name: row.name,
  email: row.email,
});

/**
 * The directory for `ids` (section 8.3): people, as `humanDirectory` and
 * `agentDirectory` allow, and the agents among them that wrote something
 * the caller can read, each with the enrollment its person signed, and
 * its person among the people, so a client can check whose agent it is.
 */
export async function directory(db: Database, actor: Actor, ids: readonly string[]) {
  const caller = await requireCaller(db, actor);
  if (ids.length === 0) return { people: [], agents: [] };
  const people =
    caller.personId === null
      ? await humanDirectory(db, caller.identity, ids)
      : await agentDirectory(db, caller, ids);
  const agents = await agentAuthors(db, caller, ids);
  const listed = new Set(people.map((person) => person.identity.id));
  const persons = await peopleById(
    db,
    agents.flatMap(({ enrollment }) =>
      listed.has(enrollment.ownerId) ? [] : [enrollment.ownerId],
    ),
  );
  return { people: [...people, ...persons], agents };
}

/**
 * People by identity ID, each at their live key, with the display name and
 * email their account shows, leaving out suspended accounts: the caller,
 * anyone who owns or owned, holds keys in, or wrote or signed something in
 * a space the caller owns, and in a space where the caller holds shares,
 * its owners past and present, and the members of, sealers in and authors
 * in the shares the caller holds. Everyone else is left out, so an ID
 * alone doesn't give away whose it is, and a member learns nothing of
 * other shares (section 7.7).
 */
async function humanDirectory(db: Database, me: PublicIdentity, ids: readonly string[]) {
  const rows = await db.execute<PersonRow>(sql`
    with owned as (
      select space_id from space_owners where identity_id = ${me.id} and removed_at is null
    ),
    held as (
      select m.share_id, s.space_id from share_members m join shares s on s.id = m.share_id
        where m.identity_id = ${me.id}
    )
    select i.id, i.kind, i.key_version, i.box_public_key, i.sign_public_key, u.name, u.email
    from identities i join users u on u.id = i.account_id
    where i.id = any(${sql`array[${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`})
      and i.kind = 'human' and i.revoked_at is null and u.suspended_at is null
      and (i.id = ${me.id}
        or exists (
          select 1 from owned where
            exists (select 1 from space_owners o
                    where o.space_id = owned.space_id and o.identity_id = i.id)
            or exists (select 1 from share_members m join shares s on s.id = m.share_id
                       where s.space_id = owned.space_id and m.identity_id = i.id)
            or exists (select 1 from revisions r
                       where r.space_id = owned.space_id and r.author_identity_id = i.id)
            or exists (select 1 from metadata_revisions r
                       where r.space_id = owned.space_id and r.author_identity_id = i.id)
            or exists (select 1 from folder_key_envelopes e
                       where e.space_id = owned.space_id and e.sealer_identity_id = i.id)
            or exists (select 1 from owner_statements st
                       where st.space_id = owned.space_id
                         and (st.signer_identity_id = i.id or st.owner_identity_id = i.id)))
        or exists (
          select 1 from held where
            exists (select 1 from space_owners o
                    where o.space_id = held.space_id and o.identity_id = i.id)
            or exists (select 1 from share_members m
                       where m.share_id = held.share_id and m.identity_id = i.id)
            or exists (select 1 from folder_key_envelopes e
                       where e.share_id = held.share_id and e.sealer_identity_id = i.id)
            or exists (select 1 from revision_wraps w join revisions r on r.id = w.revision_id
                       where w.share_id = held.share_id and r.author_identity_id = i.id)
            or exists (select 1 from metadata_wraps w
                       join metadata_revisions r on r.id = w.metadata_revision_id
                       where w.share_id = held.share_id and r.author_identity_id = i.id)))`);
  return [...rows].map(toPerson);
}

// Whether identity `id` wrote a record wrapped in one of `shareIds`.
const authoredIn = (id: SQL, shareIds: SQL) => sql`(
  exists (select 1 from revision_wraps w join revisions r on r.id = w.revision_id
          where w.share_id in (${shareIds}) and r.author_identity_id = ${id})
  or exists (select 1 from metadata_wraps w
             join metadata_revisions r on r.id = w.metadata_revision_id
             where w.share_id in (${shareIds}) and r.author_identity_id = ${id}))`;

/** Where an agent reads: its pick in each share its person can still use. */
type Pick = { spaceId: string; shareId: string; folderId: string | null };

async function agentPicks(db: Database, caller: Caller): Promise<Pick[]> {
  const { personId } = caller;
  if (personId === null) return [];
  const rows = await db
    .select({ share: shares, folderId: agentGrants.folderId })
    .from(agentGrants)
    .innerJoin(shares, eq(shares.id, agentGrants.shareId))
    .where(eq(agentGrants.agentId, caller.identity.id));
  const picks: Pick[] = [];
  for (const { share, folderId } of rows) {
    if (await personAccess(db, personId, share)) {
      picks.push({ spaceId: share.spaceId, shareId: share.id, folderId });
    }
  }
  return picks;
}

// Whether identity `id` wrote a record an agent can read through one of
// `picks`: wrapped in its share, and at or under its folder.
function authoredInPicks(id: SQL, picks: readonly Pick[]): SQL {
  if (picks.length === 0) return sql`false`;
  const within = ({ spaceId, shareId, folderId }: Pick) =>
    folderId === null
      ? authoredIn(id, sql`${shareId}`)
      : sql`exists (
          ${subtreeOf(spaceId, folderId)}
          select 1 from subtree s where
            exists (select 1 from revision_wraps w join revisions r on r.id = w.revision_id
                    where r.page_id = s.id and w.share_id = ${shareId}
                      and r.author_identity_id = ${id})
            or exists (select 1 from metadata_wraps w
                       join metadata_revisions r on r.id = w.metadata_revision_id
                       where r.subject_kind = 'folder' and r.subject_id = s.id
                         and w.share_id = ${shareId} and r.author_identity_id = ${id}))`;
  return sql`(${sql.join(picks.map(within), sql` or `)})`;
}

/**
 * The people an agent may look up (section 9.6): its own person, and the
 * authors of records it can read, which it needs to check them: at or
 * under its pick, in shares its person can still use. Suspended accounts
 * are left out.
 */
async function agentDirectory(db: Database, caller: Caller, ids: readonly string[]) {
  const picks = await agentPicks(db, caller);
  const rows = await db.execute<PersonRow>(sql`
    select i.id, i.kind, i.key_version, i.box_public_key, i.sign_public_key, u.name, u.email
    from identities i join users u on u.id = i.account_id
    where i.id = any(${idList(ids)})
      and i.kind = 'human' and i.revoked_at is null and u.suspended_at is null
      and (i.id = ${caller.personId} or ${authoredInPicks(sql`i.id`, picks)})`);
  return [...rows].map(toPerson);
}

/**
 * Agents among `ids` that wrote a record the caller can reach: in a space
 * it owns or a share it holds, or for an agent, at or under its pick.
 * A person's own agents are always listed to them, and an agent to itself.
 * Revoked agents are listed too, so what they wrote stays readable.
 */
async function agentAuthors(db: Database, caller: Caller, ids: readonly string[]) {
  const me = caller.identity.id;
  const reach =
    caller.personId === null
      ? sql`p.account_id = ${caller.accountId}
          or exists (select 1 from revisions r join space_owners o on o.space_id = r.space_id
                     where r.author_identity_id = p.agent_id
                       and o.identity_id = ${me} and o.removed_at is null)
          or exists (select 1 from metadata_revisions r join space_owners o on o.space_id = r.space_id
                     where r.author_identity_id = p.agent_id
                       and o.identity_id = ${me} and o.removed_at is null)
          or ${authoredIn(
            sql`p.agent_id`,
            sql`select share_id from share_members where identity_id = ${me}`,
          )}`
      : sql`p.agent_id = ${me} or ${authoredInPicks(sql`p.agent_id`, await agentPicks(db, caller))}`;
  const rows = await db.execute<{ agent_id: string; name: string; enrollment: unknown }>(sql`
    select p.agent_id, p.name, p.enrollment from agent_profiles p
    where p.agent_id = any(${idList(ids)}) and (${reach})`);
  return [...rows].flatMap((row) => {
    const enrollment = AgentEnrollment.safeParse(row.enrollment);
    return enrollment.success ? [{ enrollment: enrollment.data, name: row.name }] : [];
  });
}

/** People, by identity ID, for callers that have already checked access: a space's owners. */
export async function peopleById(db: Database, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await db.execute<PersonRow>(sql`
    select i.id, i.kind, i.key_version, i.box_public_key, i.sign_public_key, u.name, u.email
    from identities i join users u on u.id = i.account_id
    where i.id = any(${sql`array[${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`})
      and i.kind = 'human' and i.revoked_at is null`);
  return [...rows].map(toPerson);
}

/**
 * The person whose account has exactly this email, once normalized
 * (section 3.2), if they have a vault (section 7.3): nothing for any other
 * match, a suspended or deleted account, or the caller themself. The route
 * is rate-limited, so the directory can't be walked by guessing.
 */
export async function lookupPerson(db: Database, accountId: string, email: string) {
  const me = await requireIdentity(db, accountId);
  const normalized = normalizeEmail(email);
  const rows = await db.execute<PersonRow>(sql`
    select i.id, i.kind, i.key_version, i.box_public_key, i.sign_public_key, u.name, u.email
    from users u join identities i on i.account_id = u.id
    where u.email = ${normalized} and u.suspended_at is null
      and i.kind = 'human' and i.revoked_at is null and i.id <> ${me.id}`);
  const [person] = [...rows].map(toPerson);
  return person ?? null;
}
