// What crosses the web clipper's socket (docs/adr/0017-web-clipper.md,
// decisions 1 and 4): the browser's framing, the token's challenge with
// wikistow-clip-host (clip-host/connect.go), and the messages the
// extension sends through it.
import { FolderId, PageId, SpaceId } from '@wikistow/contracts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** The protocol versions this app takes, lowest and highest. */
export const PROTOCOLS = { min: 1, max: 1 } as const;

/** The most a `clip` may be as JSON; the extension refuses larger before sending. */
export const MAX_MESSAGE = 48 * 1024 * 1024;
/** The token's challenge is a few short fields. */
export const MAX_HANDSHAKE = 1024;
/** How long a connection has to prove it holds the token. */
export const HANDSHAKE_MS = 1_000;

/**
 * The browser's framing, which the helper copies unread: a 32-bit unsigned
 * length in the computer's own byte order, then that much UTF-8 JSON. Every
 * system WikiStow ships on is little-endian.
 */
export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameTooLarge extends Error {}

/**
 * Splits a stream into frames' bodies as its chunks arrive (`push`), one
 * at a time (`next`), so each is held to the limit in force when it is
 * read: a message sent just after the token's proof, in the same chunk,
 * isn't judged by the challenge's. One larger than `max()` is refused
 * from its header alone, before any of it is held. A frame's chunks are
 * joined once, when the last arrives.
 */
export function frameReader(max: () => number) {
  let held: Buffer[] = [];
  let heldBytes = 0;
  return {
    push(chunk: Buffer) {
      held.push(chunk);
      heldBytes += chunk.length;
    },
    /** The next whole frame's body, or null until more arrives. */
    next(): Buffer | null {
      if (heldBytes < 4) return null;
      if (held[0]!.length < 4) held = [Buffer.concat(held)];
      const size = held[0]!.readUInt32LE(0);
      if (size > max()) throw new FrameTooLarge(`A message of ${size} bytes`);
      if (heldBytes < 4 + size) return null;
      const all = held.length === 1 ? held[0]! : Buffer.concat(held);
      const rest = all.subarray(4 + size);
      held = rest.length > 0 ? [rest] : [];
      heldBytes = rest.length;
      return all.subarray(4, 4 + size);
    },
  };
}

/** HMAC-SHA256(token, role ‖ first ‖ second), as the helper computes it. */
export function proof(
  token: Uint8Array,
  role: 'app' | 'helper',
  first: Uint8Array,
  second: Uint8Array,
) {
  return createHmac('sha256', token).update(role).update(first).update(second).digest();
}

/** A 32-byte value, strictly as standard base64. */
const Bytes32 = z
  .string()
  .max(64)
  .transform((text, context) => {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== text) {
      context.addIssue({ code: 'custom', message: 'Not 32 bytes of base64' });
      return z.NEVER;
    }
    return bytes;
  });

const Challenge = z.strictObject({ v: z.literal(1), type: z.literal('challenge'), nonce: Bytes32 });
const HelperProof = z.strictObject({
  type: z.literal('proof'),
  mac: Bytes32,
  caller: z.string().max(200),
});

/**
 * The app's side of the token's challenge, one step per frame the helper
 * sends. Each MAC names its role and both nonces, so neither answer can be
 * replayed into another connection or bounced back as the other side's.
 * A client without the token can make the app compute its MAC, never the
 * helper's.
 */
export function appChallenge(token: Uint8Array) {
  const ours = randomBytes(32);
  let theirs: Buffer | null = null;
  return {
    /** The helper's challenge: the answer to send it, or null to drop the connection. */
    challenged(body: Buffer): unknown {
      const parsed = Challenge.safeParse(parseJson(body));
      if (!parsed.success || theirs) return null;
      theirs = parsed.data.nonce;
      return {
        type: 'proof',
        nonce: ours.toString('base64'),
        mac: proof(token, 'app', theirs, ours).toString('base64'),
      };
    },
    /** The helper's proof: the extension it names, or null to drop the connection. */
    proven(body: Buffer): { caller: string } | null {
      const parsed = HelperProof.safeParse(parseJson(body));
      if (!parsed.success || !theirs) return null;
      const expected = proof(token, 'helper', ours, theirs);
      return timingSafeEqual(parsed.data.mac, expected) ? { caller: parsed.data.caller } : null;
    },
  };
}

export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

const Id = z.string().min(1).max(100);

/** What every message from the extension carries, read first. */
export const Envelope = z.object({ v: z.number(), id: Id, type: z.string().max(20) });

/** At most this much HTML in a clip, or plain text (ADR 0017, decision 4). */
export const MAX_CLIP_HTML = 16 * 1024 * 1024;
/** A tab's address, at most: longer than any browser keeps in its address bar. */
const MAX_URL = 32 * 1024;

/**
 * Standard base64, padded, checked without a regular expression that
 * backtracks: a screenshot's is tens of megabytes.
 */
export function isBase64(text: string): boolean {
  if (text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) return false;
  const padding = text.indexOf('=');
  return padding === -1 || (padding >= text.length - 2 && /^=+$/.test(text.slice(padding)));
}

/** One of the extension's clips, every field held to its limit (ADR 0017, decisions 4 and 5). */
const Clip = z
  .strictObject({
    v: z.literal(1),
    id: Id,
    type: z.literal('clip'),
    mode: z.enum(['link', 'selection', 'article', 'page', 'screenshot']),
    url: z.string().min(1).max(MAX_URL),
    title: z.string().max(500),
    note: z.string().max(10_000).default(''),
    tags: z.array(z.string().max(100)).max(20).default([]),
    html: z.string().max(MAX_CLIP_HTML).default(''),
    text: z.string().max(MAX_CLIP_HTML).default(''),
    byline: z.string().max(500).nullable().default(null),
    siteName: z.string().max(500).nullable().optional(),
    folder: z.strictObject({ spaceId: SpaceId, folderId: FolderId.nullable() }),
    /**
     * A screenshot's image as base64, in `screenshot` mode alone, which has
     * no HTML. Its bytes are checked as the clip is taken (desk.ts).
     */
    screenshot: z.string().max(MAX_MESSAGE).refine(isBase64).default(''),
  })
  .refine((clip) => (clip.mode === 'screenshot') === (clip.screenshot !== ''))
  .refine((clip) => clip.mode !== 'screenshot' || (clip.html === '' && clip.text === ''));
export type ClipMessage = z.infer<typeof Clip>;

/** The messages this app answers. */
export const Message = z.discriminatedUnion('type', [
  z.strictObject({
    v: z.literal(1),
    id: Id,
    type: z.literal('hello'),
    extension: z.string().max(50).optional(),
    browser: z.string().max(50).optional(),
  }),
  z.strictObject({ v: z.literal(1), id: Id, type: z.literal('open') }),
  z.strictObject({
    v: z.literal(1),
    id: Id,
    type: z.literal('folders'),
    query: z.string().max(200),
  }),
  Clip,
  z.strictObject({
    v: z.literal(1),
    id: Id,
    type: z.literal('show'),
    spaceId: SpaceId,
    pageId: PageId,
  }),
]);
export type Message = z.infer<typeof Message>;

/** The app's state, as the extension shows it (ADR 0017, decision 7). */
export type ClipAppState = 'starting' | 'signed-out' | 'locked' | 'ready';

export type ErrorCode =
  | 'version'
  | 'invalid'
  | 'too-large'
  | 'signed-out'
  | 'locked'
  | 'no-folder'
  | 'not-allowed'
  | 'busy'
  | 'failed';
