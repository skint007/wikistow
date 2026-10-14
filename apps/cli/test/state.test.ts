import { AgentId, ShareId, SpaceId } from '@wikistow/contracts';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { LocalState } from '../src/state.ts';
import { privateDir } from './support/fake-io.ts';

const agentId = AgentId.parse(`agent-${'a'.repeat(42)}A`);
const space = SpaceId.parse('space-1');
const share = ShareId.parse('share-1');

async function fresh() {
  const { dir } = await privateDir();
  const path = join(dir, 'state');
  const key = randomBytes(32);
  return { path, key, state: LocalState.create(path, key, agentId) };
}

describe('the local state', () => {
  it('keeps what another run wrote meanwhile: the higher marks, the later mark, every pin', async () => {
    const { path, key, state: first } = await fresh();
    const second = LocalState.open(path, key, agentId);
    const other = ShareId.parse('share-2');
    const pin = { kind: 'unpin' as const, id: 'p', keyHash: 'h', removedAt: 'x' };
    first.raise(space, share, 4);
    first.keepContactsMark({ version: 9, contactsHash: 'later' });
    // The second run never saw the first's mark: its lower one doesn't win.
    second.raise(space, share, 2);
    second.raise(space, other, 2);
    second.save([pin]);
    second.keepContactsMark({ version: 8, contactsHash: 'earlier' });
    const after = LocalState.open(path, key, agentId);
    expect(after.get(space, share)).toBe(4);
    expect(after.get(space, other)).toBe(2);
    expect(after.contactsMark).toEqual({ version: 9, contactsHash: 'later' });
    expect(after.load()).toEqual([pin]);
  });
});
