import { pageOperations as pages, spaceOperations as spaces } from '@wikistow/client';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ contentLimits: { spaces: 2, folders: 1, pages: 2 } });
});
afterAll(() => t.drop());

describe('live items per account', () => {
  it('counts folders across an account’s spaces, and frees capacity when one is deleted', async () => {
    const alice = await personWithVault(t);
    const first = await spaces.createSpace(alice.ctx, { name: 'One' });
    const second = await spaces.createSpace(alice.ctx, { name: 'Two' });
    const folderId = await spaces.createFolder(alice.ctx, {
      spaceId: first,
      parentId: null,
      name: 'A',
    });
    expect(
      await rejection(
        spaces.createFolder(alice.ctx, { spaceId: second, parentId: null, name: 'B' }),
      ),
    ).toBe('folder-limit');
    // Another account has its own.
    const bob = await personWithVault(t);
    const bobs = await spaces.createSpace(bob.ctx, { name: 'Bob' });
    await spaces.createFolder(bob.ctx, { spaceId: bobs, parentId: null, name: 'C' });
    await pages.deleteNode(alice.ctx, { spaceId: first, nodeId: folderId });
    await spaces.createFolder(alice.ctx, { spaceId: second, parentId: null, name: 'B' });
  });
});
