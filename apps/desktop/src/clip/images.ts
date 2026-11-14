// The web clipper's image fetcher in main (ADR 0017, decision 5). The page
// asks for each image a clip's Markdown names; main fetches it as no
// browser tab would: with no cookies or credentials, the clipped page's
// origin as `Referer`, only from `http:` and `https:` (or a `data:`
// address), following at most five redirects, and never from this
// computer or the local network unless the clipped page is on it. Each
// name is looked up here, and the connection goes to the address checked,
// so a name can't change its answer between the check and the request.
// What comes back must say it's an image and read as one, within the
// size given.
import type { ClipImage } from '@wikistow/contracts';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { addressKind, isAddress, type AddressKind } from './addresses.ts';

/** One image at most, under the server's default upload limit (25 MiB) with room to seal it. */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const IMAGE_MS = 30_000;
const ACCEPT = 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/*;q=0.8';

export type Resolved = { address: string; family: number };
/** Every address a name has, as the system looks it up. */
export type Resolve = (host: string) => Promise<Resolved[]>;

const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    ),
  );

const bare = (host: string) =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/**
 * The image types a clip keeps, told by their first bytes, never by what
 * the server says. Not SVG: a site's SVG can hold scripts, and an
 * attachment opened as a document would run them in the app's origin.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  const ascii = (at: number, text: string) =>
    Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).every(
      (code, i) => bytes[at + i] === code,
    );
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  if (ascii(0, 'BM') && bytes.length > 14) return 'image/bmp';
  if (starts(0x00, 0x00, 0x01, 0x00) && bytes.length > 6) return 'image/x-icon';
  return null;
}

/** A `data:` address's bytes, if it says it's an image and holds one within `maxBytes`. */
export function dataImage(url: string, maxBytes: number): ClipImage {
  const comma = url.indexOf(',');
  if (!/^data:/i.test(url) || comma < 0) return { ok: false, reason: 'refused' };
  const meta = url.slice(5, comma).toLowerCase();
  const data = url.slice(comma + 1);
  const base64 = /;base64$/.test(meta);
  if (!meta.split(';')[0]!.trim().startsWith('image/')) return { ok: false, reason: 'not-image' };
  // Never decoded past the limit: a base64 address's bytes are three
  // quarters of it, and a percent-encoded one's at least a third.
  if ((base64 ? Math.floor((data.length * 3) / 4) : Math.ceil(data.length / 3)) > maxBytes) {
    return { ok: false, reason: 'too-large' };
  }
  const bytes = base64 ? Buffer.from(data, 'base64') : percentDecoded(data);
  if (!bytes) return { ok: false, reason: 'not-image' };
  if (bytes.length > maxBytes) return { ok: false, reason: 'too-large' };
  const mediaType = sniffImage(bytes);
  return mediaType ? { ok: true, bytes, mediaType } : { ok: false, reason: 'not-image' };
}

const hexValue = (code: number) =>
  code >= 0x30 && code <= 0x39
    ? code - 0x30
    : code >= 0x41 && code <= 0x46
      ? code - 0x37
      : code >= 0x61 && code <= 0x66
        ? code - 0x57
        : -1;

/**
 * A percent-encoded `data:` address's bytes, in one pass into one buffer,
 * or null if it holds anything but printable ASCII, as an image's bytes
 * written into an address are.
 */
function percentDecoded(text: string): Buffer | null {
  const out = Buffer.allocUnsafe(text.length);
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return null;
    const high = code === 0x25 ? hexValue(text.charCodeAt(i + 1)) : -1;
    const low = high >= 0 ? hexValue(text.charCodeAt(i + 2)) : -1;
    if (low >= 0) {
      out[size++] = high * 16 + low;
      i += 2;
    } else out[size++] = code;
  }
  return out.subarray(0, size);
}

/**
 * Names no one outside the person's network can answer for: one label,
 * or under a suffix that's never on the internet. A page on one of these
 * that resolves only to local addresses is on the local network, as an
 * intranet page is. Another name's records are the site's to choose, so a
 * site could claim a local address beside its own, or switch to one
 * between the browser's lookup and the app's.
 */
const LOCAL_NAME = /^[^.]+\.?$|\.(local|localhost|internal|lan|home\.arpa)\.?$/i;

export type FetchImageOptions = {
  /** The kinds of address it may come from (`allowedFor`). */
  allowed: ReadonlySet<AddressKind>;
  /** The clipped page's address, whose origin goes as `Referer`. */
  page: string;
  maxBytes: number;
  signal?: AbortSignal;
};

export type ImageFetcherOptions = {
  resolve?: Resolve;
  /** What an address is (`addressKind`); tests treat some loopback addresses as others. */
  kindOf?: (address: string) => AddressKind;
  userAgent: string;
  timeoutMs?: number;
};

export function imageFetcher({
  resolve = systemResolve,
  kindOf = addressKind,
  userAgent,
  timeoutMs = IMAGE_MS,
}: ImageFetcherOptions) {
  /**
   * The kinds of address images may come from for a page on `page`: the
   * internet, and the kind of local address the page is on itself, as an
   * intranet page is. A page is on one when its address is that local
   * address, or its name is a local one (`LOCAL_NAME`) whose addresses are
   * all local.
   */
  async function allowedFor(page: string): Promise<Set<AddressKind>> {
    const allowed = new Set<AddressKind>(['public']);
    let url: URL;
    try {
      url = new URL(page);
    } catch {
      return allowed;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return allowed;
    const host = bare(url.hostname);
    let kinds: AddressKind[];
    if (isAddress(url.hostname)) kinds = [kindOf(host)];
    else if (LOCAL_NAME.test(host)) {
      kinds = (await resolve(host).catch(() => [])).map((found) => kindOf(found.address));
    } else return allowed;
    if (kinds.includes('public') || kinds.includes('other')) return allowed;
    for (const kind of kinds) allowed.add(kind);
    return allowed;
  }

  /** The address to connect to for `url`, of a kind allowed, or null. */
  async function pinned(url: URL, allowed: ReadonlySet<AddressKind>): Promise<Resolved | null> {
    const host = bare(url.hostname);
    if (isAddress(url.hostname)) {
      return allowed.has(kindOf(host))
        ? { address: host, family: host.includes(':') ? 6 : 4 }
        : null;
    }
    const found = await resolve(host).catch(() => []);
    return found.find((one) => allowed.has(kindOf(one.address))) ?? null;
  }

  /** The image at `url`, or why not. Never throws. */
  async function fetchImage(url: string, options: FetchImageOptions): Promise<ClipImage> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return { ok: false, reason: 'refused' };
    }
    if (current.protocol === 'data:') return dataImage(url, options.maxBytes);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      for (let hop = 0; ; hop++) {
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          return { ok: false, reason: 'refused' };
        }
        const target = await pinned(current, options.allowed);
        if (!target) return { ok: false, reason: 'refused' };
        signal.throwIfAborted();
        const response = await get(current, target, referrer(options.page, current), signal);
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && location) {
          response.destroy();
          if (hop >= MAX_REDIRECTS) return { ok: false, reason: 'failed' };
          current = new URL(location, current);
          continue;
        }
        return await image(response, options.maxBytes, signal);
      }
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }

  function get(
    url: URL,
    target: Resolved,
    referer: string | null,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: bare(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // No pooled sockets, which another host's request could reuse, and
      // never the URL's user name or password.
      agent: false,
      headers: {
        'user-agent': userAgent,
        accept: ACCEPT,
        'accept-encoding': 'gzip, deflate, br',
        ...(referer && { referer }),
      },
      // The address checked, never a second lookup of the name.
      lookup: (_host, lookupOptions, callback) => {
        if ((lookupOptions as { all?: boolean }).all) {
          (callback as unknown as (e: null, all: Resolved[]) => void)(null, [target]);
        } else callback(null, target.address, target.family);
      },
      signal,
    };
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, resolve);
      request.once('error', reject);
      request.end();
    });
  }

  return { allowedFor, fetchImage };
}

/**
 * The clipped page's origin, as a browser sends it across sites by
 * default (`strict-origin-when-cross-origin`): none from a page that isn't
 * `http:` or `https:`, or from `https:` to `http:`.
 */
function referrer(page: string, to: URL): string | null {
  try {
    const from = new URL(page);
    if (from.protocol !== 'http:' && from.protocol !== 'https:') return null;
    if (from.protocol === 'https:' && to.protocol === 'http:') return null;
    return `${from.origin}/`;
  } catch {
    return null;
  }
}

async function image(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ClipImage> {
  const status = response.statusCode ?? 0;
  const type = (response.headers['content-type'] ?? '').toLowerCase().trim();
  const declared = Number(response.headers['content-length'] ?? Number.NaN);
  const refuse = (reason: 'failed' | 'not-image' | 'too-large'): ClipImage => {
    response.destroy();
    return { ok: false, reason };
  };
  if (status < 200 || status > 299) return refuse('failed');
  if (!type.startsWith('image/')) return refuse('not-image');
  if (declared > maxBytes) return refuse('too-large');
  const body = decoded(response);
  if (!body) return refuse('failed');
  const bytes = await capped(body, maxBytes, signal).finally(() => response.destroy());
  if (bytes === 'too-large') return { ok: false, reason: 'too-large' };
  const mediaType = sniffImage(bytes);
  return mediaType ? { ok: true, bytes, mediaType } : { ok: false, reason: 'not-image' };
}

/** The body as sent, undone from its content coding, or null for one this doesn't read. */
function decoded(response: IncomingMessage): Readable | null {
  const coding = (response.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
  const decoder =
    coding === 'identity' || coding === ''
      ? null
      : coding === 'gzip' || coding === 'x-gzip'
        ? createGunzip()
        : coding === 'deflate'
          ? createInflate()
          : coding === 'br'
            ? createBrotliDecompress()
            : undefined;
  if (decoder === undefined) return null;
  if (decoder === null) return response;
  response.on('error', (error) => decoder.destroy(error));
  return response.pipe(decoder);
}

/** Every byte of `stream`, or `too-large` as soon as there are more than `maxBytes`. */
function capped(stream: Readable, maxBytes: number, signal: AbortSignal) {
  return new Promise<Buffer | 'too-large'>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const aborted = () => {
      stream.destroy();
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    const done = () => signal.removeEventListener('abort', aborted);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        done();
        stream.destroy();
        return resolve('too-large');
      }
      chunks.push(chunk);
    });
    stream.once('end', () => {
      done();
      resolve(Buffer.concat(chunks));
    });
    stream.once('error', (error) => {
      done();
      reject(error);
    });
  });
}
