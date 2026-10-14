// The draft view's two editors, for the tests that switch between them.
import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

export const visual = (page: Page) => page.locator('#page-visual');

type Mode = 'Source' | 'Split' | 'Visual';

export const toggle = (page: Page, mode: Mode) =>
  page.getByRole('group', { name: 'Editor' }).getByRole('button', { name: mode });

/** Switch the draft view to `mode`, and wait for its editors. */
export async function showIn(page: Page, mode: Mode) {
  await toggle(page, mode).click();
  await expect(toggle(page, mode)).toHaveAttribute('aria-pressed', 'true');
  if (mode !== 'Source') await expect(visual(page)).toBeVisible();
  if (mode !== 'Visual') await expect(page.locator('#page-source')).toBeVisible();
}

/**
 * Put the cursor at the end of `target`, in the visual editor, and have
 * ProseMirror read it at once. Moved by a key, it's read a moment later,
 * and a change shown meanwhile puts it back where ProseMirror last had it.
 */
export async function caretAtEndOf(target: Locator) {
  await target.evaluate((element) => {
    element.closest<HTMLElement>('#page-visual')?.focus();
    const selection = element.ownerDocument.getSelection();
    selection?.selectAllChildren(element);
    selection?.collapseToEnd();
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });
}

/** Type `text` at the end of the visual editor's document. */
export async function typeAtEnd(page: Page, text: string) {
  await caretAtEndOf(visual(page));
  await page.keyboard.type(text);
}

/** Reload; the tab keeps its unlock, so the same page opens again. */
export async function reloadPage(page: Page) {
  await page.reload();
  await expect(page.locator('#page-title')).toBeVisible();
}
