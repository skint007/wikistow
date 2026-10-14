import { getConnInfo } from '@hono/node-server/conninfo';
import { isIPv4, isIPv6 } from 'node:net';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';

/**
 * The address rate limits are keyed on. X-Real-IP is only believed when a
 * proxy we control sets it (TRUST_PROXY); otherwise it's the socket address,
 * which a client can't forge.
 */
/**
 * The rate-limit key for an address. An IPv6 client usually controls a whole
 * /64, so keying on single addresses would let it rotate past any limit.
 */
export function rateLimitKey(address: string): string {
  // A dual-stack server sees IPv4 clients as ::ffff:a.b.c.d. Unwrap them, or
  // every IPv4 client would share the all-zero /64.
  const mapped = /^(?:(?:0{1,4}:){5}|::)ffff:(.+)$/i.exec(address)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (!isIPv6(address)) return address;
  const groups = expandIPv6(address);
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Eight 16-bit groups, so different spellings of one network compare equal. */
function expandIPv6(address: string): string[] {
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((g) =>
    g.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

export function clientAddress(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) return c.req.header('x-real-ip') ?? 'unknown';
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // In-process requests (tests) have no socket.
    return 'local';
  }
}
