import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Database } from '../db/client.ts';
import { AVATAR_TYPES, avatars, identities } from '../db/schema/index.ts';
import type { Actor } from '../content/identities.ts';
import { directory } from '../content/people.ts';

export type AvatarType = (typeof AVATAR_TYPES)[number];

/** An image refused as an avatar, with a message for the person who chose it. */
export class AvatarRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarRefused';
  }
}

// The file's first bytes, one character each.
const header = (bytes: Uint8Array, length: number) =>
  Buffer.from(bytes.subarray(0, length)).toString('latin1');

// Before the root element, an SVG file may hold an XML declaration, a
// document type without declarations of its own, comments and whitespace;
// the root is then `<svg` in the SVG namespace. No part can run past its own
// end (`[^<>[]`, a comment's first `-->`), so a failed match can't try
// every way of splitting the text and this stays linear.
const SVG_ROOT =
  /^(?:\s|<\?xml\b[^<>]*\?>|<!DOCTYPE\s[^<>[]*>|<!--(?:[^-]|-(?!->))*-->)*<svg(\s[^>]*)?\/?>/;
const SVG_NAMESPACE = /\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/;
const LINK_ATTRIBUTE = /\s(?:xlink:)?(?:href|src)\s*=\s*(["'])([\s\S]*?)\1/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]*)/gi;
// A link that stays inside the file: to one of its own elements, or embedded data.
const internal = (link: string) => /^(?:#|data:)/i.test(link.trim());

/**
 * Why an SVG can't be an avatar, or null if it can. Browsers never run an
 * SVG's scripts or fetch what it links to when it is shown in an `<img>`,
 * and the server sends avatars with a policy that forbids both too. This
 * refuses the obvious cases anyway, so a file that only works by loading
 * something else is turned down with a reason rather than shown broken.
 */
function svgProblem(text: string): string | null {
  // Declared entities can hide text from the checks below. Browsers never
  // fetch a document type's outside file, so a plain one is fine.
  if (/<!ENTITY|<!DOCTYPE[^<>[]*\[/i.test(text)) {
    return 'SVG images that declare entities aren’t supported.';
  }
  const root = SVG_ROOT.exec(text);
  if (!root) return 'This file isn’t an SVG image.';
  if (!SVG_NAMESPACE.test(root[1] ?? '')) {
    return 'This SVG has no xmlns="http://www.w3.org/2000/svg" on its root, so browsers won’t show it.';
  }
  // `[^<>]` keeps each tag's scan to that tag, so this stays linear.
  if (/<script\b/i.test(text) || /<[^<>]*\son[a-z]+\s*=/i.test(text)) {
    return 'SVG images with scripts aren’t supported.';
  }
  const links = [...text.matchAll(LINK_ATTRIBUTE)].map((match) => match[2] ?? '');
  const urls = [...text.matchAll(CSS_URL)].map((match) => match[2] ?? '');
  if (/@import\b/i.test(text) || ![...links, ...urls].every(internal)) {
    return 'This SVG links to files outside itself. Save it with everything embedded.';
  }
  return null;
}

const UNSUPPORTED = 'Choose a JPEG, PNG, GIF or SVG image.';

/**
 * The image type of `bytes`, read from the bytes themselves, never from a
 * file name or a type the browser claims.
 */
export function avatarType(bytes: Uint8Array): AvatarType {
  if (header(bytes, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (header(bytes, 3) === '\xff\xd8\xff') return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(header(bytes, 6))) return 'image/gif';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AvatarRefused(UNSUPPORTED);
  }
  if (!/<svg[\s>/]/.test(text)) throw new AvatarRefused(UNSUPPORTED);
  const problem = svgProblem(text);
  if (problem) throw new AvatarRefused(problem);
  return 'image/svg+xml';
}

/**
 * Store `bytes` as the account's avatar, replacing any before it, and
 * answer its new ID. The caller has already limited its size.
 */
export async function setAvatar(
  db: Database,
  accountId: string,
  bytes: Uint8Array,
): Promise<string> {
  const contentType = avatarType(bytes);
  const id = randomBytes(16).toString('base64url');
  await db
    .insert(avatars)
    .values({ accountId, id, contentType, bytes })
    .onConflictDoUpdate({
      target: avatars.accountId,
      set: { id, contentType, bytes, createdAt: new Date() },
    });
  return id;
}

export async function removeAvatar(db: Database, accountId: string): Promise<void> {
  await db.delete(avatars).where(eq(avatars.accountId, accountId));
}

/** The account's avatar ID, or null when it shows its initials. */
export async function avatarOf(db: Database, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: avatars.id })
    .from(avatars)
    .where(eq(avatars.accountId, accountId));
  return row?.id ?? null;
}

/** The image stored under an avatar ID, or null if there is none. */
export async function findAvatar(db: Database, id: string) {
  const [row] = await db
    .select({ contentType: avatars.contentType, bytes: avatars.bytes })
    .from(avatars)
    .where(eq(avatars.id, id));
  return row ?? null;
}

/**
 * The avatar IDs of the people `directory` lists for `ids`, so nobody
 * learns an avatar they couldn't learn the name beside.
 */
export async function directoryAvatars(db: Database, actor: Actor, ids: readonly string[]) {
  const { people } = await directory(db, actor, ids);
  const listed = people.map((person) => person.identity.id);
  if (listed.length === 0) return [];
  return db
    .selectDistinct({ identityId: identities.id, avatar: avatars.id })
    .from(identities)
    .innerJoin(avatars, eq(avatars.accountId, identities.accountId))
    .where(and(inArray(identities.id, listed), eq(identities.kind, 'human')));
}
