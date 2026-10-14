// Pictures for pull requests, taken only with SCREENSHOTS=1.
import type { Locator, Page } from '@playwright/test';

/**
 * With SCREENSHOTS=1, a picture of `target` as
 * `screenshots/<prefix><name>-<palette>.png`, in light and Midnight slate,
 * then `page`'s own theme again. `phone` takes it at a phone's size instead
 * of the desktop window.
 */
export const shooter =
  (page: Page, prefix = '') =>
  async (name: string, target: Page | Locator = page, phone = false) => {
    if (!process.env['SCREENSHOTS']) return;
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    const size = page.viewportSize();
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    for (const palette of ['light', 'slate']) {
      await html.evaluate((el, theme) => el.setAttribute('data-theme', theme), palette);
      await target.screenshot({
        path: `screenshots/${prefix}${name}-${palette}.png`,
        animations: 'disabled',
      });
    }
    if (before) await html.evaluate((el, theme) => el.setAttribute('data-theme', theme), before);
    if (phone && size) await page.setViewportSize(size);
  };
