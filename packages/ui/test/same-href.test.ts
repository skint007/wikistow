import { describe, expect, it } from 'vite-plus/test';
import { sameHref } from '../src/shell/same-href.ts';

describe('the same place, a trailing slash aside (#697)', () => {
  it('matches a path with or without its trailing slash, before a search or a hash too', () => {
    expect(sameHref('/s/a', '/s/a/')).toBe(true);
    expect(sameHref('/s/a?x=1', '/s/a/?x=1')).toBe(true);
    expect(sameHref('/s/a#h', '/s/a/#h')).toBe(true);
    expect(sameHref('/', '/')).toBe(true);
    expect(sameHref('/s/a', '/s/b')).toBe(false);
    expect(sameHref('/s/a?x=1', '/s/a?x=2')).toBe(false);
  });
});
