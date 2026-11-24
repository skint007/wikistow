// The `bulk-request-large` log line (ADR 0019, decision 1): a bulk request
// past half its body limit, or with a transaction past half the 60-second
// clocks, is logged with its route, sizes and space, and nothing else.
import {
  endingOperations as ending,
  moveOperations as moves,
  ownerOperations as owners,
  type SpaceId,
} from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import type { Config } from '../src/config.ts';
import { scratchApps, type TestApp } from './support/harness.ts';
import { ABOVE, find, invite, library, shareFolder, SPACE } from './support/sharing.ts';

const app = scratchApps();

const large = (t: TestApp) => t.logs.filter((entry) => entry.event === 'bulk-request-large');

/** A small move with no keys, then a share of a folder. */
async function moveThenShare(overrides: Partial<Config> = {}) {
  const t = await app(overrides);
  const owner = await personWithVault(t);
  const reader = await personWithVault(t);
  const lib = await library(owner);
  const preview = await moves.previewMove(owner.ctx, {
    spaceId: lib.spaceId,
    nodeId: lib.beside.pageId,
    parentId: lib.shared,
  });
  await moves.moveNode(owner.ctx, { preview });
  const shareId = await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, reader, 'reader')],
  });
  return { t, owner, reader, shareId, spaceId: lib.spaceId };
}

const MOVE = 'POST /api/spaces/:spaceId/nodes/:nodeId/move';
const SHARE = 'POST /api/spaces/:spaceId/shares';
const END = 'POST /api/shares/:shareId/end';
const ADD_OWNER = 'POST /api/spaces/:spaceId/owners';

describe('bulk-request-large', () => {
  it('is not logged for small, quick requests at the real thresholds', async () => {
    const { t } = await moveThenShare();
    expect(large(t)).toEqual([]);
  });

  it('is logged for a body past the threshold, and not for one under it', async () => {
    const { t, spaceId } = await moveThenShare({ bulkLarge: { bytes: 2048, ms: 60_000 } });
    const lines = large(t);
    // The move's body is a few IDs; the share's carries a wrap for each record.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: 'warn',
      event: 'bulk-request-large',
      route: SHARE,
      bodyBytes: expect.any(Number),
      transactionMs: expect.any(Number),
      spaceId,
    });
    expect(lines[0]?.['bodyBytes']).toBeGreaterThan(2048);
    expectNoContent(lines, spaceId);
  });

  it('is logged for a transaction past the time threshold, without waiting for it', async () => {
    const { t, owner, reader, shareId, spaceId } = await moveThenShare({
      bulkLarge: { bytes: 64 * 1024 * 1024, ms: 0 },
    });
    const preview = await ending.previewEnding(owner.ctx, { spaceId, shareId });
    await ending.endShare(owner.ctx, { preview });
    await owners.addCoOwner(owner.ctx, { spaceId, person: await find(owner, reader) });
    const lines = large(t);
    // The ending names the space of the share it ended.
    expect(lines.map((line) => line['route'])).toEqual([MOVE, SHARE, END, ADD_OWNER]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        ['bodyBytes', 'event', 'level', 'route', 'spaceId', 'transactionMs'].sort(),
      );
      expect(line['spaceId']).toBe(spaceId);
      expect(line['bodyBytes']).toBeLessThan(64 * 1024 * 1024);
    }
    expectNoContent(lines, spaceId);
  });
});

/** The lines carry no names or content of the library, outside the space's ID. */
function expectNoContent(lines: Record<string, unknown>[], spaceId: SpaceId) {
  expect(lines.every((line) => line['spaceId'] === spaceId)).toBe(true);
  // A random ID could hold a short title such as `Plan`.
  const text = JSON.stringify(lines.map((line) => ({ ...line, spaceId: undefined })));
  for (const secret of [SPACE, ABOVE, 'Shared', 'Plan', 'published words', 'draft words']) {
    expect(text).not.toContain(secret);
  }
}
