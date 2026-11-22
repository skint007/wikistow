import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { newSpace } from './sharing';
import { adminTab, memberWithVault, newPage } from './vault';

/**
 * On a phone, the drawer holds the rail and the open space's sidebar.
 * Picking a space there opens its sidebar in the drawer, which stays open
 * so a page in it can be picked, with no filter typed in the space before;
 * picking that page closes it (#694).
 */
test('on a phone, picking a space keeps the drawer open for its pages', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newSpace(page, 'Garden');
  await newPage(page, 'Seed list');
  await newSpace(page, 'Kitchen');
  await newPage(page, 'Bean soup');

  await page.setViewportSize({ width: 390, height: 700 });
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(drawer.getByRole('heading', { name: 'Kitchen', level: 2 })).toBeVisible();
  // A filter typed in one space's sidebar doesn't carry over to the next.
  await drawer.getByRole('textbox', { name: 'Filter pages' }).fill('Bean');

  await drawer.getByRole('link', { name: 'Garden', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Garden', level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  // Still open once the space has opened behind it.
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();

  await drawer.getByRole('treeitem', { name: 'Seed list' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#page-title')).toHaveValue('Seed list');

  // Going back to where the tap went is a move of its own, which closes it.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  await expect(drawer).toBeHidden();
  await page.goForward();
  await expect(page.locator('#page-title')).toHaveValue('Seed list');

  // Its own space's tile, from a page in it, keeps it open too; Trash closes it.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await drawer.getByRole('link', { name: 'Garden', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();
  // Tapped again on the space shown, it adds no entry for Back to land on (#697).
  await drawer.getByRole('link', { name: 'Garden', exact: true }).click();
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();
  await drawer.getByRole('link', { name: 'Trash' }).click();
  await expect(drawer).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  await page.goBack();
  await expect(page.locator('#page-title')).toHaveValue('Seed list');
});

/**
 * A plugin drawing the rail opens a space with `host.app.navigate`, which
 * keeps the drawer open on that space's sidebar as the app's own tiles do,
 * when a tap in the drawer's rail made it; a move to a page closes it (#697).
 */
test('on a phone, a plugin’s rail opening a space keeps the drawer open for its pages', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(120_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const spaceOf = () => /\/s\/([^/?#]+)/.exec(page.url())?.[1];
  await newSpace(page, 'Garden');
  await newPage(page, 'Seed list');
  const garden = spaceOf();
  await newSpace(page, 'Kitchen');
  await newPage(page, 'Bean soup');
  const kitchen = /\/s\/([^/]+)\/p\/([^/?#]+)/.exec(page.url());
  if (!garden || !kitchen) throw new Error('No space in the address');

  // Built by hand, with the spaces' IDs in it, so it needs no page access.
  const dist = mkdtempSync(join(tmpdir(), 'drawer-rail-'));
  writeFileSync(
    join(dist, 'wikistow-plugin.json'),
    JSON.stringify({
      id: 'drawer-rail',
      name: 'Drawer rail',
      version: '0.1.0',
      api: 1,
      ui: 'ui.js',
      replaces: ['rail'],
    }),
  );
  const go = (label: string, to: object) =>
    `button(${JSON.stringify(label)}, ${JSON.stringify(to)});`;
  writeFileSync(
    join(dist, 'ui.js'),
    `export default {
      activate(host) {
        host.ui.replace('rail', {
          id: 'rail',
          view(element) {
            const button = (label, to) => {
              const made = document.createElement('button');
              made.textContent = label;
              made.onclick = () => void host.app.navigate(to);
              element.append(made);
            };
            ${go('Garden', { kind: 'space', spaceId: garden })}
            ${go('Soup', { kind: 'page', spaceId: kitchen[1], pageId: kitchen[2] })}
          },
        });
      },
    };`,
  );
  await page.goto('/settings/plugins?tab=library');
  await page.getByLabel('Plugin folder').setInputFiles(dist);
  const approval = page.getByRole('dialog');
  await expect(approval).toContainText('It replaces the rail with its own.');
  await approval.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Uploaded and installed Drawer rail 0.1.0.')).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(`/s/${kitchen[1]}/p/${kitchen[2]}`);
  await expect(page.locator('#page-title')).toHaveValue('Bean soup');

  await page.setViewportSize({ width: 390, height: 700 });
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await drawer.getByRole('button', { name: 'Garden' }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${garden}/?$`));
  await expect(drawer.getByRole('heading', { name: 'Garden', level: 2 })).toBeVisible();
  // Still open once the space has opened behind it.
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();
  // The space shown already, tapped again: still open, with no entry added for Back.
  await drawer.getByRole('button', { name: 'Garden' }).click();
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();
  await page.goBack();
  await expect(page.locator('#page-title')).toHaveValue('Bean soup');
  await expect(drawer).toBeHidden();

  // A page opened from the rail closes it, as any other move does.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/s/${garden}/?$`));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await drawer.getByRole('button', { name: 'Soup' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#page-title')).toHaveValue('Bean soup');
});
