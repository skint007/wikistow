// Sending a change of a share (protocol section 6.8, accepted with ADR
// 0015): pending until a definite answer, which raises the mark of an
// accepted rotation or ending; after a lost answer, pending until the app
// fetches the shares again and sees which way it went.
import { describe, expect, it } from 'vite-plus/test';
import {
  ApiError,
  ENDED,
  generateIdentity,
  IdentityId,
  MemoryKeyVersionMarks,
  ShareId,
  SpaceId,
  type ClientContext,
} from '../src/index.ts';
import {
  changePending,
  LOST_GRACE_MS,
  SEND_LIMIT_MS,
  type NewChange,
} from '../src/key-versions.ts';
import { sendShareChange, settleShareChanges } from '../src/operations/share-changes.ts';

const alice = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const rotation: NewChange = { spaceId, shareId, change: 'rotation', fromKeyVersion: 1 };

// What `settleShareChanges` reads: the shares the server lists, and the
// versions this app holds, with who sealed each.
function context({
  shares = [] as { shareId: ShareId; currentKeyVersion: number }[],
  held = [] as { keyVersion: number; sealer: string }[],
} = {}) {
  const marks = new MemoryKeyVersionMarks();
  const asked: string[] = [];
  const spaces = new Map([[spaceId, Promise.resolve()]]);
  const ctx = {
    identity: alice,
    marks,
    spaces,
    api: {
      call: (route: { path: string }) => {
        asked.push(route.path);
        return Promise.resolve({
          shares: shares.map((s) => ({ ...s, spaceId })),
          folders: [],
          pages: [],
        });
      },
    },
    keyring: { versions: () => held.map((h) => ({ ...h, sealer: { id: h.sealer } })) },
  } as unknown as ClientContext;
  return { ctx, marks, asked, spaces };
}

describe('sending a change of a share', () => {
  it('counts as lost when an earlier try got no answer, whatever the last one said', async () => {
    const { ctx, marks } = context();
    const refused = new ApiError(408, 'request-timeout', 'Too slow');
    await expect(
      sendShareChange(
        ctx,
        [rotation],
        () => Promise.reject(refused),
        () => [],
        {
          lostMeanwhile: () => true,
        },
      ),
    ).rejects.toBe(refused);
    expect(marks.pending()).toMatchObject([{ lost: true }]);
  });

  it('raises the mark on marks that keep no pending changes', async () => {
    const raisedOnly = {
      get: () => 0,
      raised: [] as number[],
      raise(_s: unknown, _h: unknown, v: number) {
        this.raised.push(v);
      },
    };
    const ctx = { marks: raisedOnly } as unknown as ClientContext;
    await sendShareChange(
      ctx,
      [rotation],
      () => Promise.resolve(1),
      () => [{ spaceId, shareId, keyVersion: 2 }],
    );
    expect(raisedOnly.raised).toEqual([2]);
  });

  it('is pending while it is sent, and raises the mark once accepted', async () => {
    const { ctx, marks } = context();
    let during = false;
    await sendShareChange(
      ctx,
      [rotation],
      () => {
        during = changePending(marks, spaceId, shareId);
        return Promise.resolve({ keyVersion: 2 });
      },
      () => [{ spaceId, shareId, keyVersion: 2 }],
    );
    expect(during).toBe(true);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
    expect(marks.get(spaceId, shareId)).toBe(2);
  });

  it('clears a refused change without raising anything', async () => {
    const { ctx, marks } = context();
    const refused = new ApiError(409, 'stale-head', 'Another owner rotated first');
    await expect(
      sendShareChange(
        ctx,
        [rotation],
        () => Promise.reject(refused),
        () => [{ spaceId, shareId, keyVersion: 2 }],
      ),
    ).rejects.toBe(refused);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
    expect(marks.get(spaceId, shareId)).toBe(0);
  });

  it('keeps a change whose answer was lost pending, marked lost', async () => {
    const { ctx, marks } = context();
    const lost = new ApiError(0, 'network', 'No answer');
    await expect(
      sendShareChange(
        ctx,
        [rotation],
        () => Promise.reject(lost),
        () => [],
      ),
    ).rejects.toBe(lost);
    expect(marks.pending()).toMatchObject([{ shareId, lost: true }]);
  });
});

describe('settling a change whose answer was lost', () => {
  // Past the grace a lost answer gets, as the server may still be committing it.
  const later = () => Date.now() + LOST_GRACE_MS + 1;

  it('waits out the grace after a lost answer', async () => {
    const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    const [begun] = await marks.begin([rotation]);
    await marks.lose([begun?.id ?? '']);
    await settleShareChanges(ctx, spaceId);
    expect(changePending(marks, spaceId, shareId)).toBe(true);
    await settleShareChanges(ctx, spaceId, later());
    expect(changePending(marks, spaceId, shareId)).toBe(false);
  });

  const lostOne = async (marks: MemoryKeyVersionMarks, change = rotation) => {
    const [begun] = await marks.begin([change]);
    await marks.lose([begun?.id ?? '']);
  };

  it('raises the mark when the share is at a version this app sealed', async () => {
    const { ctx, marks } = context({
      shares: [{ shareId, currentKeyVersion: 2 }],
      held: [{ keyVersion: 2, sealer: 'alice' }],
    });
    await lostOne(marks);
    await settleShareChanges(ctx, spaceId, later());
    expect(marks.get(spaceId, shareId)).toBe(2);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
  });

  it('raises nothing when the share is still at the old version, or another owner’s', async () => {
    for (const held of [[], [{ keyVersion: 2, sealer: 'bob' }]]) {
      const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 2 }], held });
      await lostOne(marks);
      await settleShareChanges(ctx, spaceId, later());
      expect(marks.get(spaceId, shareId)).toBe(0);
      expect(changePending(marks, spaceId, shareId)).toBe(false);
    }
  });

  it('settles a lost move only once it has fetched the tree again, forgetting what it worked out', async () => {
    const { ctx, marks, asked, spaces } = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    await lostOne(marks, { ...rotation, change: 'move' });
    await settleShareChanges(ctx, spaceId, later());
    expect(changePending(marks, spaceId, shareId)).toBe(false);
    expect(asked.some((path) => path.includes('tree'))).toBe(true);
    expect(spaces.size).toBe(0);
    expect(marks.get(spaceId, shareId)).toBe(0);
  });

  it('marks an ending done only when the share is gone', async () => {
    const ending: NewChange = { ...rotation, change: 'ending' };
    const gone = context();
    await lostOne(gone.marks, ending);
    await settleShareChanges(gone.ctx, spaceId, later());
    expect(gone.marks.get(spaceId, shareId)).toBe(ENDED);
    const still = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    await lostOne(still.marks, ending);
    await settleShareChanges(still.ctx, spaceId, later());
    expect(still.marks.get(spaceId, shareId)).toBe(0);
  });

  it('never settles a change still being sent, unless its sender went silent', async () => {
    const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    const [begun] = await marks.begin([rotation]);
    await settleShareChanges(ctx, spaceId);
    expect(changePending(marks, spaceId, shareId)).toBe(true);
    await settleShareChanges(ctx, spaceId, (begun?.at ?? 0) + SEND_LIMIT_MS + 1);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
  });
});
