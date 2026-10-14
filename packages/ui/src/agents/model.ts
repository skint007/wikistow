/** What the agents pages offer, from the person's access and record. Pure, so it is table-tested. */
import { normalizeLookupCode, pinLabel, type ContactsPayloads } from '@wikistow/client';
import type { Access } from '../sharing/model';
import { shareCovering, shareTarget } from '../sharing/model';

const ACCESS_ORDER: readonly Access[] = ['reader', 'editor', 'publisher'];

/** The access levels up to `max`, lowest first: an agent never gets more than its person. */
export const accessUpTo = (max: Access): Access[] =>
  ACCESS_ORDER.slice(0, ACCESS_ORDER.indexOf(max) + 1);

/**
 * A lookup code as typed, in the form the CLI shows (`XXXX-XXXX`), or null
 * while it isn't eight Crockford symbols. Case, spaces, dashes and the
 * look-alikes I, L and O don't matter (protocol section 9.2).
 */
export function lookupCodeInput(typed: string): string | null {
  const code = normalizeLookupCode(typed.trim());
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

/** The enrollment fingerprint's ten groups of four, as the CLI prints them. */
export const fingerprintGroups = (fingerprint: string): string[] =>
  fingerprint.split(' ').filter(Boolean);

/** "first" to "tenth": which fingerprint group the person is asked to type. */
export const GROUP_ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
] as const;

/**
 * Whether the group the person typed from their CLI is group `index` of the
 * fingerprint this app worked out: `match`, `mismatch`, or `incomplete`
 * while fewer than four symbols are typed. Case and spaces don't matter.
 * Typing one group back turns the comparison into something the person
 * does, rather than a claim the server relays (protocol section 9.2).
 */
export function checkGroup(
  fingerprint: string,
  index: number,
  typed: string,
): 'match' | 'mismatch' | 'incomplete' {
  const group = fingerprintGroups(fingerprint)[index];
  const entered = typed.replace(/\s+/g, '').toLowerCase();
  if (entered.length < 4) return 'incomplete';
  return group !== undefined && entered === group.toLowerCase() ? 'match' : 'mismatch';
}

/**
 * How often to ask where a claimed enrollment is, in milliseconds: until
 * the CLI says yes or the enrollment ends. Before any answer, as after a
 * check that failed, it keeps asking.
 */
export const enrollmentPoll = (state: string | undefined): number | false =>
  state === undefined || state === 'claimed' ? 1500 : false;

/** An agent as its person's contacts record lists it: enough to tell names apart. */
type Listed = { agentId: string; name: string; revokedAt: string | null };

// A day as the person's own calendar has it, in the form the CLI and the
// record use: YYYY-MM-DD.
const localDay = (iso: string) => {
  const at = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
};

/** The most an agent name may be, in UTF-16 units (the server's `AgentName`). */
export const MAX_AGENT_NAME = 100;

/**
 * Whether a new agent can be called `name` (protocol section 8.2: names are
 * unique among the person's agents). A revoked agent keeps its name in the
 * record, so reusing it first renames that one, to `rename`, which says
 * the day it was revoked.
 */
export type NameCheck =
  | { kind: 'free' }
  | { kind: 'taken' }
  | { kind: 'revoked'; agentId: string; rename: string };

export function checkAgentName(name: string, agents: readonly Listed[]): NameCheck {
  const holder = agents.find((agent) => agent.name === name);
  if (!holder) return { kind: 'free' };
  if (holder.revokedAt === null) return { kind: 'taken' };
  const taken = new Set(agents.map((agent) => agent.name));
  const suffix = ` (revoked ${localDay(holder.revokedAt)})`;
  for (let n = 1; ; n += 1) {
    const end = n === 1 ? suffix : `${suffix.slice(0, -1)}, ${n})`;
    // Cut whole characters only, so a long name never ends in half an emoji.
    let kept = '';
    for (const { segment } of new Intl.Segmenter().segment(name)) {
      if (kept.length + segment.length + end.length > MAX_AGENT_NAME) break;
      kept += segment;
    }
    const rename = kept + end;
    if (!taken.has(rename)) return { kind: 'revoked', agentId: holder.agentId, rename };
  }
}

type Folder<Id extends string> = { id: Id; parentId: string | null; name: string | null };
type TreeShare = {
  shareId: string;
  rootId: string | null;
  role: 'reader' | 'editor' | 'owner';
  canPublish: boolean;
};

/** A person's own access in a share, the most their agent may get there; an owner's is all of it. */
export const accessIn = (share: Pick<TreeShare, 'role' | 'canPublish'>): Access =>
  share.role === 'owner'
    ? 'publisher'
    : share.role === 'reader'
      ? 'reader'
      : share.canPublish
        ? 'publisher'
        : 'editor';

/**
 * A folder, or the whole space, a person may pick for their agent
 * (protocol section 9.4): the most access it may get there, and whether
 * picking it makes it a share first (`newShare`, in the owner region of a
 * space they own). `path` names it from the top of what they can see. An
 * agent has one pick per share, so a second pick in a share replaces it.
 */
export type Place<Id extends string = string> = {
  folderId: Id | null;
  path: string[];
  max: Access;
  /** The share it is in, or null when picking it makes it one (`newShare`). */
  shareId: string | null;
  newShare: boolean;
};

/** A place that can't be picked, and why: it holds a share, so it can't become one. */
export type Unpickable<Id extends string = string> = {
  folderId: Id | null;
  path: string[];
  reason: 'holds-share';
};

/**
 * Where in a space a person may pick: for its owner (`owner`, who may act
 * as one), anywhere, a share as editor with publish and the owner region as
 * a new share, except a place holding a share; for a member, each share
 * they hold and the folders in it, at their own access there. Folders this
 * app couldn't name aren't offered, nor is the whole space when its own
 * name failed its checks (`spaceOpened` false): the space itself can't be
 * shared then, though its folders can. A name in a newer format opened, so
 * that space is offered. Both lists go by path, as the server lists folders in no set
 * order.
 */
export function placesIn<Id extends string>(
  tree: { shares: readonly TreeShare[]; folders: readonly Folder<Id>[] },
  {
    owner,
    spaceName,
    spaceOpened,
  }: { owner: boolean; spaceName: string | null; spaceOpened: boolean },
): { places: Place<Id>[]; unpickable: Unpickable<Id>[] } {
  const named = tree.folders.filter((f): f is Folder<Id> & { name: string } => f.name !== null);
  const byId = new Map<string, (typeof named)[number]>(named.map((f) => [f.id, f]));
  const pathOf = (folderId: string): string[] | null => {
    const path: string[] = [];
    for (let id: string | null = folderId; id !== null; id = byId.get(id)?.parentId ?? null) {
      const folder = byId.get(id);
      if (!folder || path.length > named.length) return null;
      path.unshift(folder.name);
    }
    return path;
  };
  const places: Place<Id>[] = [];
  const unpickable: Unpickable<Id>[] = [];
  const top = spaceName === null ? [] : [spaceName];

  if (owner) {
    const candidates: (Id | null)[] = [...(spaceOpened ? [null] : []), ...named.map((f) => f.id)];
    for (const folderId of candidates) {
      const rel = folderId === null ? [] : pathOf(folderId);
      if (rel === null) continue;
      const path = [...top, ...rel];
      const target = shareTarget(tree, folderId);
      if (target.kind === 'holds') unpickable.push({ folderId, path, reason: 'holds-share' });
      else {
        const shareId = target.kind === 'new' ? null : target.share.shareId;
        places.push({ folderId, path, max: 'publisher', shareId, newShare: shareId === null });
      }
    }
    return { places: places.sort(byPath), unpickable: unpickable.sort(byPath) };
  }
  for (const share of tree.shares) {
    if (share.rootId === null && spaceOpened) {
      const { shareId } = share;
      places.push({
        folderId: null,
        path: top,
        max: accessIn(share),
        shareId,
        newShare: false,
      });
    }
  }
  for (const folder of named) {
    const share = shareCovering(tree, folder.id);
    const path = pathOf(folder.id);
    if (!share || !path) continue;
    places.push({
      folderId: folder.id,
      path: share.rootId === null ? [...top, ...path] : path,
      max: accessIn(share),
      shareId: share.shareId,
      newShare: false,
    });
  }
  return { places: places.sort(byPath), unpickable };
}

// By path, then by ID where two paths read the same.
const byPath = (
  a: { path: string[]; folderId: string | null },
  b: { path: string[]; folderId: string | null },
) =>
  a.path.join('\u0000').localeCompare(b.path.join('\u0000')) ||
  (a.folderId ?? '').localeCompare(b.folderId ?? '');

/** The folders above `folderId`, nearest first, from the tree's parent links. */
export function ancestorsOf<Id extends string>(
  folders: readonly { id: Id; parentId: string | null }[],
  folderId: Id | null,
): Id[] {
  const byId = new Map<string, { id: Id; parentId: string | null }>(folders.map((f) => [f.id, f]));
  const above: Id[] = [];
  let parentId = folderId === null ? null : (byId.get(folderId)?.parentId ?? null);
  while (parentId !== null && above.length <= folders.length) {
    const parent = byId.get(parentId);
    if (!parent) break;
    above.push(parent.id);
    parentId = parent.parentId;
  }
  return above;
}

/** What `withPick` needs to know of a pick: where it is, and what is above it. */
type PickPlace = {
  spaceId: string;
  folderId: string | null;
  shareId: string | null;
  newShare: boolean;
  /** The folders above it (`ancestorsOf`); the space is above every folder. */
  ancestors: readonly string[];
};

/**
 * Add a pick to those chosen so far (protocol section 9.4). An agent has
 * one pick per share, so a pick replaces another in the same share, or of
 * the same place. Picks that become shares can't nest: the inner one would
 * be inside the outer share by the time it is made. So the outer one is
 * kept, whichever came first, and `merged` names the two, for the screen
 * to say so.
 */
export function withPick<P extends PickPlace>(
  picks: readonly P[],
  pick: P,
): { picks: P[]; merged: { inner: P; outer: P } | null } {
  const contains = (outer: P, inner: P) =>
    outer.spaceId === inner.spaceId &&
    outer.folderId !== inner.folderId &&
    (outer.folderId === null || inner.ancestors.includes(outer.folderId));
  const rest = picks.filter(
    (p) =>
      !(pick.shareId !== null && p.shareId === pick.shareId) &&
      !(p.spaceId === pick.spaceId && p.folderId === pick.folderId),
  );
  if (!pick.newShare) return { picks: [...rest, pick], merged: null };
  const outer = rest.find((p) => p.newShare && contains(p, pick));
  if (outer) return { picks: rest, merged: { inner: pick, outer } };
  const inner = rest.find((p) => p.newShare && contains(pick, p));
  return {
    picks: [...rest.filter((p) => !(p.newShare && contains(pick, p))), pick],
    merged: inner ? { inner, outer: pick } : null,
  };
}

/**
 * How long ago `iso` was, as the status pills say it: "just now", "5 min",
 * "3 h", "2 d", then the date.
 */
export function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} d`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

type ListedGrants = {
  agentId: string;
  revokedAt: string | null;
  grants: readonly { spaceId: string; shareId: string; role: 'reader' | 'editor' }[];
};
type RecordedAgent = {
  enrollment: { agent: { id: string } };
  shares: readonly { spaceId: string; shareId: string; drafts: boolean }[];
};

/**
 * A pick the server lists that this person's own record doesn't back
 * (protocol section 9.4): `unrecorded` when the record doesn't list the
 * share for the agent at all, `role-differs` when it does, with other draft
 * rights (`recorded`, the record's own role). Their apps seal only what the
 * record says, so the record is the truth: the fix is to bring the server
 * in line with it, never the record in line with the server. That also
 * covers a removal or a demotion whose server call failed after the record
 * was written.
 */
export type OffRecord = {
  agentId: string;
  spaceId: string;
  shareId: string;
} & ({ kind: 'unrecorded' } | { kind: 'role-differs'; recorded: 'reader' | 'editor' });

export function picksOffRecord(
  listed: readonly ListedGrants[],
  recorded: readonly RecordedAgent[],
): OffRecord[] {
  return listed.flatMap((agent) => {
    if (agent.revokedAt !== null) return [];
    const entry = recorded.find((r) => r.enrollment.agent.id === agent.agentId);
    return agent.grants.flatMap((grant): OffRecord[] => {
      const where = { agentId: agent.agentId, spaceId: grant.spaceId, shareId: grant.shareId };
      const share = entry?.shares.find(
        (s) => s.spaceId === grant.spaceId && s.shareId === grant.shareId,
      );
      if (!share) return [{ ...where, kind: 'unrecorded' }];
      if (share.drafts === (grant.role === 'editor')) return [];
      return [{ ...where, kind: 'role-differs', recorded: share.drafts ? 'editor' : 'reader' }];
    });
  });
}

/**
 * The access to set a pick back to when the server's role differs from the
 * record's: the record's role, never more than the person has there now
 * (`max`). The record names no publish right, so an editor goes back
 * without it.
 */
export const recordedAccess = (recorded: 'reader' | 'editor', max: Access): Access =>
  recorded === 'reader' || max === 'reader' ? 'reader' : 'editor';

/**
 * The shares a revoked agent may hold keys to, for offering new keys
 * (protocol section 9.7): those the person's own record lists for it
 * first, since those are what their apps sealed, then any more the server
 * lists, each once. The server can hide a grant, but not a record entry.
 */
export function sharesItHeld<S extends { spaceId: string; shareId: string }>(
  recorded: readonly S[],
  listed: readonly S[],
): S[] {
  const seen = new Set<string>();
  return [...recorded, ...listed].filter((share) => {
    const key = `${share.spaceId}/${share.shareId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The shares the record lists for `agentId`, as one value: two differ
 * exactly when the record changed what the agent may reach.
 */
export const recordedShares = (agents: readonly RecordedAgent[], agentId: string): string =>
  JSON.stringify(
    (agents.find((a) => a.enrollment.agent.id === agentId)?.shares ?? []).map((s) => [
      s.spaceId,
      s.shareId,
      s.drafts,
    ]),
  );

/** Whom an agent works for, and whether that name is only the server's. */
export type AgentPerson = { name: string; served: boolean };

/**
 * Whom an agent the server names works for, as this app names them
 * (protocol section 9.5): the label this person pinned for `personId`,
 * which the server can't change, where there is one; otherwise the
 * server's own name for them (`serverName`), marked `served`, or null.
 */
export function agentPersonName(
  ctx: { contacts: { book: { payloads: ContactsPayloads } } },
  personId: string | null,
  serverName: string | null,
): AgentPerson | null {
  const { shared, private: own } = ctx.contacts.book.payloads;
  const pin = personId === null ? null : shared.contacts.find((c) => c.identity.id === personId);
  const label = pin && pinLabel(pin, own.labels)?.name;
  if (label) return { name: label, served: false };
  return serverName === null ? null : { name: serverName, served: true };
}
