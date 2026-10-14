import { describe, expect, it } from 'vite-plus/test';
import { standingFrom } from '../src/sharing/owner-standing.ts';

describe('owner standing', () => {
  it('treats a failed check as unconfirmed, never as an owner', () => {
    expect(standingFrom({ status: 'error', data: undefined })).toBe('unconfirmed');
    // A refetch that fails after an earlier clear answer doesn't keep it.
    expect(standingFrom({ status: 'error', data: null })).toBe('unconfirmed');
  });
});
