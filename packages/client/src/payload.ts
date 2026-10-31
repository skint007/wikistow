import { pageRoutes } from '@wikistow/contracts';
import { z } from 'zod';
import { Base64, FORMAT_INTEGERS, Hash32, utf8 } from './encoding.ts';
import { CryptoError } from './errors.ts';
import { AttachmentId } from './ids.ts';
import type { JsonPathPattern } from './json.ts';

/** The payload format this client writes. Minor bumps are additive; major bumps are not. */
// 1.1 adds `AttachmentRef.plainHash`.
export const PAYLOAD_FORMAT = { major: 1, minor: 1 } as const;

/** A payload format version. Loose, so fields a newer client adds survive. */
export const Format = z.looseObject({
  major: z.number().int().positive(),
  minor: z.number().int().nonnegative(),
});

/** An attachment as listed inside an encrypted payload. Its name and key are content. */
export const AttachmentRef = z.looseObject({
  id: AttachmentId,
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  key: Base64,
  /** Hash of the encrypted blob, so the signed payload pins the exact bytes. */
  blobHash: Hash32,
  /** Hash of the plaintext, scoped to the page (`plainHash`). Since format 1.1; a ref without it is never reused. */
  plainHash: Hash32.optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** The page payload fields typed as integers, which must be written as plain integer tokens. */
export const PAYLOAD_INTEGERS: readonly JsonPathPattern[] = [
  ...FORMAT_INTEGERS,
  ['attachments', '*', 'size'],
  ['extensions', 'wikistow.links', 'format'],
  ['extensions', 'wikistow.publication', 'format'],
  ['extensions', 'wikistow.rehome', 'format'],
  ['extensions', 'wikistow.cover', 'format'],
  ['extensions', 'wikistow.cover', 'banner', 'focal'],
  ['extensions', 'wikistow.cover', 'banner', 'height'],
  ['extensions', 'wikistow.cover', 'banner', 'fade'],
];

/**
 * The decrypted content of one revision. `extensions` holds namespaced data
 * such as `wikistow.links`. Objects are loose so fields from a newer minor
 * version survive a save by an older client, just like unknown namespaces.
 *
 * Format rule for every version and extension: key material lives only in
 * `attachments[].key`. Anything else that needs a file refers to it by
 * attachment ID. Publishing re-encrypts each listed attachment and copies the
 * rest unchanged, so a key stored anywhere else would leak to readers.
 */
export const PagePayload = z.looseObject({
  format: Format.extend({ major: z.literal(PAYLOAD_FORMAT.major) }),
  title: z.string(),
  markdown: z.string(),
  attachments: z.array(AttachmentRef),
  extensions: z.record(z.string(), z.json()),
});
export type PagePayload = z.infer<typeof PagePayload>;

export type OpenedPayload =
  | { kind: 'current'; payload: PagePayload }
  /** Written by a newer client. Readable by that client only; this one must not save over it. */
  | { kind: 'newer-format'; format: z.infer<typeof Format> };

export function parsePayload(json: unknown): OpenedPayload {
  const format = z.object({ format: Format }).safeParse(json);
  if (!format.success)
    throw new CryptoError('malformed', 'Payload has no format version', { cause: format.error });
  if (format.data.format.major > PAYLOAD_FORMAT.major)
    return { kind: 'newer-format', format: format.data.format };
  if (!isPagePayload(json)) {
    const { error } = PagePayload.safeParse(json);
    throw new CryptoError('malformed', 'Payload has an invalid shape', { cause: error });
  }
  return { kind: 'current', payload: json };
}

// Validate, but keep the caller's object rather than Zod's copy. Zod rebuilds
// loose objects by assignment, which turns a data key named "__proto__" into a
// prototype change and silently drops it. Spreads and JSON.stringify keep it.
export const isPagePayload = (json: unknown): json is PagePayload =>
  PagePayload.safeParse(json).success;

/**
 * A version larger than a page may hold: its Markdown past
 * `MAX_MARKDOWN_BYTES`, or the whole payload past `MAX_PAYLOAD_BYTES`.
 * Thrown before anything is sent.
 */
export class PageTooLarge extends Error {
  /** What is too large: the Markdown, or the whole payload. */
  readonly part: 'markdown' | 'payload';
  /** Its UTF-8 bytes. */
  readonly bytes: number;
  /** The most a version may hold of it. */
  readonly limit: number;

  constructor(part: 'markdown' | 'payload', bytes: number, limit: number) {
    const what =
      part === 'markdown'
        ? 'This page’s Markdown'
        : 'This page, with its links and attachment list,';
    super(`${what} is ${kilobytes(bytes)}, more than the ${kilobytes(limit)} a page can hold.`);
    this.name = 'PageTooLarge';
    this.part = part;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** `bytes` as the messages say it: KB of 1,024 bytes, rounded up. */
export const kilobytes = (bytes: number) => `${Math.ceil(bytes / 1024).toLocaleString('en')} KB`;

/**
 * Refuse `payload` with `PageTooLarge` if one version can't hold it. Given
 * only its Markdown, as before the rest is worked out, it checks that much.
 */
export function checkPayloadSize(payload: Pick<PagePayload, 'markdown'>): void {
  const { MAX_MARKDOWN_BYTES, MAX_PAYLOAD_BYTES } = pageRoutes;
  const markdown = utf8(payload.markdown).length;
  if (markdown > MAX_MARKDOWN_BYTES)
    throw new PageTooLarge('markdown', markdown, MAX_MARKDOWN_BYTES);
  const whole = utf8(JSON.stringify(payload)).length;
  if (whole > MAX_PAYLOAD_BYTES) throw new PageTooLarge('payload', whole, MAX_PAYLOAD_BYTES);
}

export type PayloadChanges = Partial<
  Pick<PagePayload, 'title' | 'markdown' | 'attachments' | 'extensions'>
>;

export function newPayload(
  content: Pick<PagePayload, 'title' | 'markdown'> & PayloadChanges,
): PagePayload {
  return { format: { ...PAYLOAD_FORMAT }, attachments: [], extensions: {}, ...content };
}

/**
 * The payload for the next revision. Everything this client doesn't touch is
 * carried over unchanged, including extension namespaces and fields it has
 * never heard of. `changes.extensions` replaces only the namespaces it names.
 */
export function revisePayload(previous: OpenedPayload, changes: PayloadChanges): PagePayload {
  if (previous.kind === 'newer-format') {
    const { major, minor } = previous.format;
    throw new CryptoError(
      'unsupported-format',
      `Payload format ${major}.${minor} is newer than this client; update to save`,
    );
  }
  const { payload } = previous;
  return {
    ...payload,
    ...changes,
    format: {
      ...payload.format,
      major: PAYLOAD_FORMAT.major,
      minor: Math.max(payload.format.minor, PAYLOAD_FORMAT.minor),
    },
    extensions: { ...payload.extensions, ...changes.extensions },
  };
}
