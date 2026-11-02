import { PageId, SpaceId, type ClientContext, type UnlockedVault } from '@wikistow/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { expect } from 'vite-plus/test';
import { vaultStore } from '../src/vault/store.ts';

// What a page's views need around them in a test: an open vault, which
// keeps their properties' open state, and the page they show.

/** Open the vault, with nothing behind it. */
export const openVault = (ctx = {} as ClientContext) => vaultStore.unlock(ctx, {} as UnlockedVault);

export const PAGE_REF = { spaceId: SpaceId.parse('s-home'), pageId: PageId.parse('p-self') };

/** Open the Properties box in `container`, which starts collapsed, unless it's open already. */
export async function openProperties(container: ParentNode) {
  await expect
    .poll(() => container.querySelector('section[aria-label=Properties] > button'))
    .not.toBeNull();
  const toggle = container.querySelector<HTMLElement>('section[aria-label=Properties] > button')!;
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true');
}
