// Where an address leads, for the web clipper's image fetcher (ADR 0017,
// decision 5): so a page can't use a clip to reach the person's own
// computer or local network. Pure, so it is table-tested.
import { isIP } from 'node:net';

/**
 * What an IP address is: on the internet (`public`), this computer
 * (`loopback`), a private or shared network (`private`), a link-local one
 * (`link-local`), or anything else no image comes from, such as an
 * unspecified, multicast, reserved or documentation address (`other`).
 */
export type AddressKind = 'public' | 'loopback' | 'private' | 'link-local' | 'other';

type V4Range = readonly [first: number, bits: number, kind: AddressKind];

const v4 = (a: number, b: number, c: number, d: number) =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

// IANA's IPv4 special-purpose registry, as far as it matters here.
const V4_RANGES: readonly V4Range[] = [
  // "This network": 0.0.0.0 reaches this computer on Linux and macOS.
  [v4(0, 0, 0, 0), 8, 'other'],
  [v4(10, 0, 0, 0), 8, 'private'],
  // Shared address space (carrier NAT, and Tailscale's addresses).
  [v4(100, 64, 0, 0), 10, 'private'],
  [v4(127, 0, 0, 0), 8, 'loopback'],
  [v4(169, 254, 0, 0), 16, 'link-local'],
  [v4(172, 16, 0, 0), 12, 'private'],
  [v4(192, 0, 0, 0), 24, 'other'],
  [v4(192, 0, 2, 0), 24, 'other'],
  [v4(192, 88, 99, 0), 24, 'other'],
  [v4(192, 168, 0, 0), 16, 'private'],
  // Benchmarking, routed only inside a lab.
  [v4(198, 18, 0, 0), 15, 'private'],
  [v4(198, 51, 100, 0), 24, 'other'],
  [v4(203, 0, 113, 0), 24, 'other'],
  // Multicast, then reserved, and the broadcast address.
  [v4(224, 0, 0, 0), 4, 'other'],
  [v4(240, 0, 0, 0), 4, 'other'],
];

function v4Kind(value: number): AddressKind {
  for (const [first, bits, kind] of V4_RANGES) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === first) return kind;
  }
  return 'public';
}

function parseV4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value >>> 0;
}

/** An IPv6 address's 16 bytes, its zone dropped, or null. */
export function parseV6(text: string): Uint8Array | null {
  const address = text.split('%')[0]!;
  if (isIP(address) !== 6) return null;
  const bytes = new Uint8Array(16);
  let head = address;
  let tail4: number | null = null;
  const lastColon = address.lastIndexOf(':');
  if (address.slice(lastColon + 1).includes('.')) {
    tail4 = parseV4(address.slice(lastColon + 1));
    if (tail4 === null) return null;
    head = `${address.slice(0, lastColon + 1)}0:0`;
  }
  const [left, right] = head.includes('::') ? head.split('::') : [head, null];
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const leftGroups = groups(left);
  const rightGroups = right === null ? [] : groups(right);
  const missing = 8 - leftGroups.length - rightGroups.length;
  const all = [
    ...leftGroups,
    ...Array<string>(right === null ? 0 : missing).fill('0'),
    ...rightGroups,
  ];
  if (all.length !== 8) return null;
  all.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  if (tail4 !== null) {
    bytes[12] = tail4 >>> 24;
    bytes[13] = (tail4 >>> 16) & 0xff;
    bytes[14] = (tail4 >>> 8) & 0xff;
    bytes[15] = tail4 & 0xff;
  }
  return bytes;
}

const embedded = (bytes: Uint8Array, at: number) =>
  v4(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

function startsWith(bytes: Uint8Array, prefix: readonly number[], bits: number) {
  for (let bit = 0; bit < bits; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[byte]! & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function v6Kind(bytes: Uint8Array): AddressKind {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  if (zeros(0, 16)) return 'other';
  if (zeros(0, 15) && bytes[15] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and the well-known NAT64 prefix carry an IPv4 address.
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4Kind(embedded(bytes, 12));
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) return v4Kind(embedded(bytes, 12));
  // Local-use NAT64 (RFC 8215).
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return 'private';
  // The rest of ::/8 (IPv4-compatible, unspecified-ish) and the discard prefix.
  if (bytes[0] === 0 || startsWith(bytes, [0x01, 0x00], 64)) return 'other';
  // 6to4 carries an IPv4 address; Teredo's is hidden, and documentation's never routed.
  if (startsWith(bytes, [0x20, 0x02], 16)) return v4Kind(embedded(bytes, 2));
  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return 'other';
  if (startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return 'other';
  if (startsWith(bytes, [0xfc], 7)) return 'private';
  if (startsWith(bytes, [0xfe, 0x80], 10)) return 'link-local';
  // Site-local, deprecated but still routed inside some networks.
  if (startsWith(bytes, [0xfe, 0xc0], 10)) return 'private';
  if (bytes[0] === 0xff) return 'other';
  // Only global unicast, 2000::/3, is on the internet.
  return startsWith(bytes, [0x20], 3) ? 'public' : 'other';
}

/** What `address`, an IPv4 or IPv6 address as text, is; `other` if it isn't one. */
export function addressKind(address: string): AddressKind {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (isIP(bare) === 4) return v4Kind(parseV4(bare)!);
  const bytes = parseV6(bare);
  return bytes ? v6Kind(bytes) : 'other';
}

/** Whether `host`, a URL's hostname, is an IP address rather than a name. */
export const isAddress = (host: string) =>
  isIP(host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host) !== 0;
