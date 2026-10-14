import { describe, expect, it } from 'vite-plus/test';
import { rateLimitKey } from '../src/http/client-address.ts';

describe('rateLimitKey', () => {
  it('unwraps IPv4 clients seen through a dual-stack socket', () => {
    expect(rateLimitKey('::ffff:198.51.100.1')).toBe('198.51.100.1');
    expect(rateLimitKey('0:0:0:0:0:FFFF:198.51.100.2')).toBe('198.51.100.2');
    expect(rateLimitKey('::ffff:198.51.100.1')).not.toBe(rateLimitKey('::ffff:198.51.100.2'));
  });
});
