// The No going back marks a device keeps, across a browser's tabs (protocol
// section 6.8, accepted with ADR 0015): pending changes of a share, recorded
// before they are sent and told to every tab; clears that never come undone;
// and tabs reading the file again when told.
import { describe, expect, it } from 'vite-plus/test';
import {
  generateIdentity,
  IdentityId,
  InstallationId,
  KeptMarks,
  ShareId,
  SpaceId,
  type KeptFile,
  type MarksChannel,
} from '../src/index.ts';
import { changePending } from '../src/key-versions.ts';

const identity = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
const installationId = InstallationId.parse('test-installation');
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const other = ShareId.parse('other');
const who = { identity, installationId };

// One browser: a file its tabs share, written in turn under a lock, and a
// channel that delivers each tab's post to the others.
function browser() {
  let kept: Uint8Array | null = null;
  let turn = Promise.resolve();
  const listeners = new Set<{ from: number; listener: () => void }>();
  let tabs = 0;
  const tab = (): KeptFile => {
    const me = ++tabs;
    const channel: MarksChannel = {
      post: () => {
        for (const { from, listener } of listeners) if (from !== me) listener();
      },
      listen: (listener) => {
        const entry = { from: me, listener };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    };
    return {
      read: async () => kept,
      write: async (sealed) => {
        kept = sealed;
      },
      exclusive: <T>(work: () => Promise<T>) => {
        const run = turn.then(work);
        turn = run.then(
          () => {},
          () => {},
        );
        return run;
      },
      channel,
    };
  };
  return { tab };
}

const change = (shareId_ = shareId) => ({
  spaceId,
  shareId: shareId_,
  change: 'rotation' as const,
  fromKeyVersion: 1,
});

describe('pending changes across tabs', () => {
  it('records a change in the file before it resolves, and tells the other tabs', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    let told = 0;
    two.onChange(() => (told += 1));
    const [begun] = await one.begin([change()]);
    expect(begun).toMatchObject({ shareId, lost: false });
    // The other tab read the file again when told.
    await expect.poll(() => changePending(two, spaceId, shareId)).toBe(true);
    expect(told).toBeGreaterThan(0);
    // So does a later launch.
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(true);
    expect(changePending(later, spaceId, other)).toBe(false);
  });

  it('raises the mark and clears the change on a definite answer', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    const [begun] = await one.begin([change()]);
    await one.settle([begun?.id ?? ''], [{ spaceId, shareId, keyVersion: 2 }]);
    expect(one.get(spaceId, shareId)).toBe(2);
    expect(changePending(one, spaceId, shareId)).toBe(false);
    await expect.poll(() => two.get(spaceId, shareId)).toBe(2);
    await expect.poll(() => changePending(two, spaceId, shareId)).toBe(false);
  });

  it('never brings back a cleared change, whatever a tab that missed the clear writes', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    // A tab that never hears the others.
    const deaf = await KeptMarks.open({ ...b.tab(), channel: undefined }, who);
    const [begun] = await one.begin([change()]);
    await deaf.refresh();
    expect(changePending(deaf, spaceId, shareId)).toBe(true);
    await one.settle([begun?.id ?? ''], []);
    // The deaf tab still holds the change, and writes something else.
    deaf.raise(spaceId, other, 5);
    await expect.poll(async () => (await KeptMarks.open(b.tab(), who)).get(spaceId, other)).toBe(5);
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(false);
    expect(changePending(deaf, spaceId, shareId)).toBe(false);
  });

  it('never drops a change another tab began meanwhile', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open({ ...b.tab(), channel: undefined }, who);
    await Promise.all([one.begin([change()]), two.begin([change(other)])]);
    const later = await KeptMarks.open(b.tab(), who);
    expect(changePending(later, spaceId, shareId)).toBe(true);
    expect(changePending(later, spaceId, other)).toBe(true);
  });

  it('keeps a change whose answer was lost, marked so', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const [begun] = await one.begin([change()]);
    await one.lose([begun?.id ?? '']);
    const later = await KeptMarks.open(b.tab(), who);
    expect(later.pending()).toMatchObject([{ id: begun?.id, lost: true }]);
  });

  it('takes in other tabs’ higher marks when told, though it raised none itself', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    one.raise(spaceId, shareId, 4);
    await expect.poll(() => two.get(spaceId, shareId)).toBe(4);
  });

  it('stops listening once closed', async () => {
    const b = browser();
    const one = await KeptMarks.open(b.tab(), who);
    const two = await KeptMarks.open(b.tab(), who);
    two.close();
    await one.begin([change()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changePending(two, spaceId, shareId)).toBe(false);
  });
});
