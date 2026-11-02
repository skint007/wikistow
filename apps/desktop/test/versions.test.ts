import { describe, expect, it } from 'vite-plus/test';
import { channelOf, compare, newer, newestFor } from '../src/versions.ts';

describe('compare', () => {
  it('orders versions by semantic version precedence', () => {
    const sorted = [
      '0.23.0',
      '0.22.0',
      '0.23.0-beta.10',
      '0.23.0-beta.2',
      '0.23.0-rc.1',
      '0.23.0-beta',
      '0.22.1',
    ].sort(compare);
    expect(sorted).toEqual([
      '0.22.0',
      '0.22.1',
      '0.23.0-beta',
      '0.23.0-beta.2',
      '0.23.0-beta.10',
      '0.23.0-rc.1',
      '0.23.0',
    ]);
  });

  it('ignores build metadata', () => {
    expect(compare('0.22.0+ca534447', '0.22.0')).toBe(0);
  });
});

describe('newer', () => {
  it('offers a beta to a beta, and its release', () => {
    expect(newer('0.23.0-beta.2', '0.23.0-beta.1')).toBe(true);
    expect(newer('0.23.0', '0.23.0-beta.2')).toBe(true);
    expect(newer('0.23.0-beta.1', '0.23.0')).toBe(false);
  });

  it('offers nothing for a version it cannot read', () => {
    expect(newer('nightly', '0.22.0')).toBe(false);
    expect(newer('0.23.0', 'dev')).toBe(false);
  });
});

describe('channelOf', () => {
  it('follows the package, then the version', () => {
    expect(channelOf('0.23.0', 'beta\n')).toBe('beta');
    expect(channelOf('0.23.0-beta.1', null)).toBe('beta');
    expect(channelOf('0.23.0', null)).toBe('stable');
    expect(channelOf('0.23.0', 'stable')).toBe('stable');
  });
});

describe('newestFor', () => {
  // As GitHub lists them: by date, so a fix to an older line can come first.
  const releases = [
    { tag_name: 'v0.22.1', prerelease: false },
    { tag_name: 'v0.23.0-beta.2', prerelease: true },
    { tag_name: 'v0.23.0-beta.1', prerelease: true },
    { tag_name: 'v0.24.0', draft: true },
    { tag_name: 'v0.22.0', prerelease: false },
    { tag_name: 'not-a-version' },
  ];

  it('gives the stable channel the newest stable release', () => {
    expect(newestFor('stable', releases)).toBe('0.22.1');
  });

  it('gives the beta channel the newest release of any kind', () => {
    expect(newestFor('beta', releases)).toBe('0.23.0-beta.2');
    expect(newestFor('beta', [...releases, { tag_name: 'v0.23.0' }])).toBe('0.23.0');
  });

  it('keeps a release GitHub marks as a prerelease off the stable channel', () => {
    expect(newestFor('stable', [{ tag_name: 'v0.30.0', prerelease: true }])).toBe(null);
  });

  it('never offers a draft', () => {
    expect(newestFor('beta', [{ tag_name: 'v0.24.0', draft: true }])).toBe(null);
  });
});
