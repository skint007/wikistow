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
import {
  fetchToSettle,
  sendShareChange,
  settleShareChanges,
} from '../src/operations/share-changes.ts';

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

  it('settles a lost move, raising nothing', async () => {
    const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    await lostOne(marks, { ...rotation, change: 'move' });
    await settleShareChanges(ctx, spaceId, later());
    expect(changePending(marks, spaceId, shareId)).toBe(false);
    expect(marks.get(spaceId, shareId)).toBe(0);
  });

  it('clears what a person who can’t list the shares any more sent', async () => {
    const { ctx, marks } = context();
    (ctx as unknown as { api: unknown }).api = {
      call: () => Promise.reject(new ApiError(403, 'forbidden', 'Not an owner')),
    };
    await lostOne(marks);
    await settleShareChanges(ctx, spaceId, later());
    expect(changePending(marks, spaceId, shareId)).toBe(false);
    expect(marks.get(spaceId, shareId)).toBe(0);
  });

  it('ends or moves whatever version the mark is at, but asks again once the share is ended', async () => {
    for (const change of ['move'] as const) {
      const { ctx, marks } = context();
      marks.raise(spaceId, shareId, 3);
      await expect(
        sendShareChange(
          ctx,
          [{ ...rotation, change }],
          () => Promise.resolve(),
          () => [],
        ),
      ).resolves.toBeUndefined();
      marks.raise(spaceId, shareId, ENDED);
      await expect(
        sendShareChange(
          ctx,
          [{ ...rotation, change }],
          () => Promise.resolve(),
          () => [],
        ),
      ).rejects.toMatchObject({ code: 'stale-head' });
    }
  });

  it('asks again for a move into a share whose wraps a rotation has overtaken', async () => {
    const { ctx, marks } = context();
    marks.raise(spaceId, shareId, 4);
    const into: NewChange = { ...rotation, change: 'move', fromKeyVersion: 3, into: true };
    await expect(
      sendShareChange(
        ctx,
        [into],
        () => Promise.resolve(),
        () => [],
      ),
    ).rejects.toMatchObject({ code: 'stale-head' });
    await expect(
      sendShareChange(
        ctx,
        [{ ...into, fromKeyVersion: 4 }],
        () => Promise.resolve(),
        () => [],
      ),
    ).resolves.toBeUndefined();
    // Out of a share, the version is the share's own business.
    const out: NewChange = { ...rotation, change: 'move', fromKeyVersion: 1 };
    await expect(
      sendShareChange(
        ctx,
        [out],
        () => Promise.resolve(),
        () => [],
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a share this app ended that its ending’s scan found listed again', async () => {
    const { ctx, marks } = context();
    marks.raise(spaceId, shareId, 3);
    const ending: NewChange = { ...rotation, change: 'ending', fromKeyVersion: 1 };
    await expect(
      sendShareChange(
        ctx,
        [ending],
        () => Promise.resolve(),
        () => [],
      ),
    ).resolves.toBeUndefined();
    marks.raise(spaceId, shareId, ENDED);
    await expect(
      sendShareChange(
        ctx,
        [ending],
        () => Promise.resolve(),
        () => [],
      ),
    ).rejects.toMatchObject({ code: 'key-version' });
  });

  it('raises nothing, ending or not, when the server refuses the listing', async () => {
    const ending: NewChange = { ...rotation, change: 'ending' };
    for (const [refusal, clears] of [
      [new ApiError(403, 'forbidden', 'Not an owner'), true],
      [new ApiError(401, 'unauthenticated', 'Signed out'), false],
      [new ApiError(429, 'rate-limited', 'Slow down'), false],
    ] as const) {
      const { ctx, marks } = context();
      (ctx as unknown as { api: unknown }).api = { call: () => Promise.reject(refusal) };
      await lostOne(marks, ending);
      await settleShareChanges(ctx, spaceId, later()).catch(() => {});
      expect(marks.get(spaceId, shareId), refusal.code).toBe(0);
      expect(changePending(marks, spaceId, shareId), refusal.code).toBe(!clears);
    }
  });

  it('asks to plan again, sending nothing, for a rotation the mark has overtaken', async () => {
    const { ctx, marks } = context();
    marks.raise(spaceId, shareId, 2);
    let sent = false;
    await expect(
      sendShareChange(
        ctx,
        [rotation],
        () => {
          sent = true;
          return Promise.resolve();
        },
        () => [],
      ),
    ).rejects.toMatchObject({ code: 'stale-head' });
    expect(sent).toBe(false);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
  });

  it('fetches again to settle at most once per grace period', async () => {
    const { ctx, marks } = context();
    await lostOne(marks);
    const at = later();
    expect(fetchToSettle(ctx, spaceId, at)).toBe(true);
    expect(fetchToSettle(ctx, spaceId, at + 1)).toBe(false);
    expect(fetchToSettle(ctx, spaceId, at + LOST_GRACE_MS + 1)).toBe(true);
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

  it('never settles another tab’s change while that tab holds its lock, as when frozen', async () => {
    const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    // Another tab began it and froze mid-send: its renewals stopped, its lock held.
    const [begun] = await marks.begin([rotation]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    void navigator.locks.request(`wikistow-share-change-${begun?.id ?? ''}`, () => held);
    await expect
      .poll(async () => (await navigator.locks.query()).held?.length ?? 0)
      .toBeGreaterThan(0);
    const silent = (begun?.at ?? 0) + SEND_LIMIT_MS + 1;
    await settleShareChanges(ctx, spaceId, silent);
    expect(changePending(marks, spaceId, shareId)).toBe(true);
    // Closed, it lets go of the lock, and a fetch settles it.
    release();
    await expect.poll(async () => (await navigator.locks.query()).held?.length ?? 0).toBe(0);
    await settleShareChanges(ctx, spaceId, silent);
    expect(changePending(marks, spaceId, shareId)).toBe(false);
  });

  it('never settles a change this tab is still sending, however late its renewals', async () => {
    const { ctx, marks } = context({ shares: [{ shareId, currentKeyVersion: 1 }] });
    let finish: () => void = () => {};
    const sent = sendShareChange(
      ctx,
      [rotation],
      () => new Promise<void>((resolve) => (finish = resolve)),
      () => [{ spaceId, shareId, keyVersion: 2 }],
    );
    await expect.poll(() => changePending(marks, spaceId, shareId)).toBe(true);
    await settleShareChanges(ctx, spaceId, Date.now() + SEND_LIMIT_MS + LOST_GRACE_MS + 1);
    expect(changePending(marks, spaceId, shareId)).toBe(true);
    finish();
    await sent;
    expect(marks.get(spaceId, shareId)).toBe(2);
  });
});
