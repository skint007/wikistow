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
import { changePending, SEND_LIMIT_MS } from '../src/key-versions.ts';
import { sendShareChange, settleShareChanges } from '../src/operations/share-changes.ts';

const alice = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const rotation = { spaceId, shareId, change: 'rotation' as const, fromKeyVersion: 1 };

// What `settleShareChanges` reads: the shares the server lists, and the
// versions this app holds, with who sealed each.
function context({
  shares = [] as { shareId: ShareId; currentKeyVersion: number }[],
  held = [] as { keyVersion: number; sealer: string }[],
} = {}) {
  const marks = new MemoryKeyVersionMarks();
  const ctx = {
    identity: alice,
    marks,
    api: { call: () => Promise.resolve({ shares: shares.map((s) => ({ ...s, spaceId })) }) },
    keyring: { versions: () => held.map((h) => ({ ...h, sealer: { id: h.sealer } })) },
  } as unknown as ClientContext;
  return { ctx, marks };
}

describe('sending a change of a share', () => {
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
    await settleShareChanges(ctx, spaceId);
    expect(marks.get(spaceId, shareId)).toBe(2);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
  });

  it('raises nothing when the share is still at the old version, or another owner’s', async () => {
    for (const held of [[], [{ keyVersion: 2, sealer: 'bob' }]]) {
      const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 2 }], held });
      await lostOne(marks);
      await settleShareChanges(ctx, spaceId);
      expect(marks.get(spaceId, shareId)).toBe(0);
      expect(changePending(marks, spaceId, shareId)).toBe(false);
    }
  });

  it('marks an ending done only when the share is gone', async () => {
    const ending = { ...rotation, change: 'ending' as const };
    const gone = context();
    await lostOne(gone.marks, ending);
    await settleShareChanges(gone.ctx, spaceId);
    expect(gone.marks.get(spaceId, shareId)).toBe(ENDED);
    const still = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    await lostOne(still.marks, ending);
    await settleShareChanges(still.ctx, spaceId);
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
