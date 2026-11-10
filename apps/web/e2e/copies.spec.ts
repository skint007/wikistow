import type { Page } from '@playwright/test';
import { expect, pick, test } from './fixtures';
import {
  folderMenu,
  newFolder,
  newSpace,
  openFolder,
  openShared,
  publishedPageIn,
  shareFolder,
} from './sharing';
import { adminTab, memberWithVault } from './vault';

/** The space in view, from the address. */
const spaceIn = (page: Page) => new URL(page.url()).pathname.split('/')[2] ?? '';

/** Open a space from the rail. */
async function openSpace(page: Page, name: string) {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

/** Choose where an open Move or Copy dialog sends it: Move or Copy is next, in the same step. */
async function choose(dialog: ReturnType<Page['getByRole']>, space: string, folder: string) {
  await pick(dialog.getByLabel(/^Space:/), space);
  await pick(dialog.getByLabel(/^Folder:/), folder);
}

/**
 * An owner copies a folder of two linked pages into another space, and
 * within its own space, then moves a page into the other space (ADR 0007).
 */
test('copying and moving pages and folders between spaces', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  await memberWithVault(owner, adminPage);

  let family = '';
  let work = '';
  await test.step('the owner writes two linked pages in Family, and makes Work', async () => {
    await newSpace(owner, 'Family');
    family = spaceIn(owner);
    await newFolder(owner, 'Garden');
    await publishedPageIn(owner, 'Garden', 'Seeds', 'Sow thinly, and water well.');
    await publishedPageIn(owner, 'Garden', 'Plan', 'Read [[Seeds]] before sowing.');
    await newFolder(owner, 'Errands');
    await publishedPageIn(owner, 'Errands', 'Shopping', 'Buy more beans.');
    await publishedPageIn(
      owner,
      'Errands',
      'List',
      '---\nrelated: "[[Shopping]]"\n---\nThen the [[Shopping]].',
    );
    await publishedPageIn(
      owner,
      'Errands',
      'Overview',
      '```wikistow-query\nfrom: Errands\nshow: related\n```\n',
    );
    await newSpace(owner, 'Work');
    work = spaceIn(owner);
  });

  await test.step('the owner copies Garden into Work, and its link still works', async () => {
    await openSpace(owner, 'Family');
    await folderMenu(owner, 'Garden', 'Copy to…');
    const dialog = owner.getByRole('dialog', { name: 'Copy “Garden”' });
    await choose(dialog, 'Work', 'Top of Work');
    await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
    // Nobody else reads Work, and a copy ends nothing.
    await expect(dialog).not.toContainText('will be able to read it');
    await expect(dialog).not.toContainText('It ends');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(owner).toHaveURL(new RegExp(`/s/${work}/f/`));
    await expect(
      owner.getByRole('status').filter({ hasText: 'Copied “Garden” to Work.' }),
    ).toBeVisible();

    await openFolder(owner, 'Garden');
    await owner.getByRole('treeitem', { name: 'Plan' }).click();
    await expect(owner.getByRole('heading', { name: 'Plan', level: 1 })).toBeVisible();
    await owner.getByRole('link', { name: 'Seeds' }).click();
    await expect(owner.getByRole('heading', { name: 'Seeds', level: 1 })).toBeVisible();
    await expect(owner.getByText('Sow thinly, and water well.')).toBeVisible();
    await expect(owner).toHaveURL(new RegExp(`/s/${work}/p/`));

    // The source stays.
    await openSpace(owner, 'Family');
    await expect(owner.getByRole('treeitem', { name: /Garden/ })).toHaveCount(1);
  });

  await test.step('the owner copies Garden within Family', async () => {
    await folderMenu(owner, 'Garden', 'Copy to…');
    const dialog = owner.getByRole('dialog', { name: 'Copy “Garden”' });
    await choose(dialog, 'Family (this space)', 'Top of Family');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(owner).toHaveURL(new RegExp(`/s/${family}/f/`));
    await expect(owner.getByRole('treeitem', { name: /Garden/ })).toHaveCount(2);
  });

  let oldAddress = '';
  let newAddress = '';
  let publicLink = '';
  await test.step('the owner moves Shopping into Work, published there and gone here', async () => {
    await openFolder(owner, 'Errands');
    await owner.getByRole('treeitem', { name: 'Shopping' }).click();
    await expect(owner.getByRole('heading', { name: 'Shopping', level: 1 })).toBeVisible();
    oldAddress = new URL(owner.url()).pathname;
    await owner.getByRole('button', { name: 'Page actions' }).click();
    await owner.getByRole('menuitem', { name: 'Share public link…' }).click();
    const sharing = owner.getByRole('dialog', { name: /Shopping/ });
    await sharing.getByRole('button', { name: 'Turn on public link' }).click();
    await expect(sharing.getByLabel('Public link')).toHaveValue(/\/p\//);
    publicLink = await sharing.getByLabel('Public link').inputValue();
    await sharing.getByRole('button', { name: 'Done' }).click();

    await owner.getByRole('button', { name: 'Page actions' }).click();
    await owner.getByRole('menuitem', { name: 'Move to…' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Move “Shopping”' });
    await choose(dialog, 'Work', 'Top of Work');
    // The owner can publish there, so its public link goes with it: only earlier versions end.
    await expect(dialog).toContainText('Its earlier versions and comments don’t go with it.');
    await expect(dialog).not.toContainText('public link');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(owner).toHaveURL(new RegExp(`/s/${work}/p/`));
    await expect(owner.getByText('Buy more beans.')).toBeVisible();
    await expect(owner.getByText('Published v1')).toBeVisible();
    newAddress = new URL(owner.url()).pathname;

    await openSpace(owner, 'Family');
    await openFolder(owner, 'Errands');
    await expect(owner.getByRole('treeitem', { name: 'Shopping' })).toHaveCount(0);
  });

  await test.step('its public link keeps working once its public page is updated', async () => {
    const visit = async () => (await owner.request.get(publicLink)).text();
    expect(await visit()).toContain('This page is being updated');
    await owner.goto(newAddress);
    await owner.getByRole('button', { name: 'Page actions' }).click();
    await owner.getByRole('menuitem', { name: 'Share public link…' }).click();
    const sharing = owner.getByRole('dialog', { name: /Shopping/ });
    await expect(sharing.getByLabel('Public link')).toHaveValue(publicLink);
    await sharing.getByRole('button', { name: 'Update public page' }).click();
    await expect(sharing.getByText('The public page is out of date.')).toHaveCount(0);
    await sharing.getByRole('button', { name: 'Done' }).click();
    expect(await visit()).toContain('Buy more beans.');
  });

  await test.step('its old address, and a link to it left behind, open it in Work', async () => {
    await owner.goto(oldAddress);
    await expect(owner).toHaveURL(new RegExp(`${newAddress}$`));
    await expect(
      owner.getByRole('note').filter({ hasText: 'This page moved to Work.' }),
    ).toBeVisible();
    await expect(owner.getByText('Buy more beans.')).toBeVisible();

    await openSpace(owner, 'Family');
    await openFolder(owner, 'Errands');
    await owner.getByRole('treeitem', { name: 'List' }).click();
    await owner.getByRole('link', { name: 'Shopping' }).click();
    await expect(owner).toHaveURL(new RegExp(`${newAddress}$`));
    await expect(owner.getByText('Buy more beans.')).toBeVisible();
    // Opened by a link to where it is now, it doesn't say it moved.
    await expect(owner.getByText('This page moved to Work.')).toHaveCount(0);
  });

  await test.step('the folder table and a query block left behind link to it in Work', async () => {
    await openSpace(owner, 'Family');
    await folderMenu(owner, 'Errands', 'Open');
    // An editor's table cells edit their values: the list's open their links.
    const folder = owner.getByRole('region', { name: 'Folder' });
    await folder
      .getByRole('group', { name: 'Show as' })
      .getByRole('button', { name: 'List' })
      .click();
    await folder
      .getByRole('listitem')
      .filter({ hasText: 'List' })
      .getByRole('link', { name: 'Shopping' })
      .click();
    await expect(owner).toHaveURL(new RegExp(`${newAddress}$`));

    await openSpace(owner, 'Family');
    await openFolder(owner, 'Errands');
    await owner.getByRole('treeitem', { name: 'Overview' }).click();
    const query = owner.locator('.query-table');
    await query.getByRole('row', { name: /List/ }).getByRole('link', { name: 'Shopping' }).click();
    await expect(owner).toHaveURL(new RegExp(`${newAddress}$`));
  });
});

/**
 * An editor who isn't an owner of the space is told that only its owners
 * move things into another space, and offered a copy instead.
 */
test('an editor who isn’t an owner can’t move into another space', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const eda = await freshPage();
  await memberWithVault(owner, adminPage);
  const { email: edaEmail } = await memberWithVault(eda, adminPage);

  await test.step('the owner shares Notes with Eda as an editor', async () => {
    await newSpace(owner, 'Club');
    await newFolder(owner, 'Notes');
    await publishedPageIn(owner, 'Notes', 'Agenda', 'Tea, then the accounts.');
    await shareFolder(owner, 'Notes', edaEmail, 'editor');
    await owner.keyboard.press('Escape');
  });

  await test.step('Eda sees Move to another space unavailable, and can copy', async () => {
    await openShared(eda, 'Notes', 'Agenda');
    await eda.getByRole('button', { name: 'Page actions' }).click();
    await eda.getByRole('menuitem', { name: 'Move to…' }).click();
    const dialog = eda.getByRole('dialog', { name: 'Move “Agenda”' });
    await expect(dialog).toContainText(
      'Only an owner of this space can move things into another space.',
    );
    await dialog.getByLabel(/^Space:/).click();
    await expect(eda.getByRole('menuitemradio')).toHaveCount(1);
    await eda.keyboard.press('Escape');

    await dialog.getByRole('button', { name: 'Copy instead' }).click();
    await expect(eda.getByRole('dialog', { name: 'Copy “Agenda”' })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await eda
      .getByRole('dialog')
      .getByLabel(/^Space:/)
      .click();
    await expect(eda.getByRole('menuitemradio')).toHaveCount(2);
  });
});

/**
 * An owner moves everything in a space into a folder of another, from the
 * space menu, while a folder of it is open (#339). Its old address leads to
 * the other space as the tree changes, which must not take the dialog away
 * before it asks whether to delete the empty space.
 */
test('moving everything in a space into another, then deleting it', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  await memberWithVault(owner, adminPage);
  await newSpace(owner, 'Family');
  await newFolder(owner, 'Garden');
  await publishedPageIn(owner, 'Garden', 'Seeds', 'Sow thinly.');
  await newSpace(owner, 'Work');
  await newFolder(owner, 'Archive');
  await openSpace(owner, 'Family');
  await openFolder(owner, 'Garden');
  await owner.getByRole('treeitem', { name: 'Seeds' }).click();
  await expect(owner.getByRole('heading', { name: 'Seeds', level: 1 })).toBeVisible();
  const oldAddress = new URL(owner.url()).pathname;
  await folderMenu(owner, 'Garden', 'Copy to…');
  const copying = owner.getByRole('dialog', { name: 'Copy “Garden”' });
  await choose(copying, 'Family (this space)', 'Top of Family');
  await copying.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(owner).toHaveURL(/\/f\//, { timeout: 60_000 });

  await owner.getByRole('button', { name: 'Space menu' }).click();
  await owner.getByRole('menuitem', { name: 'Move space into…' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Move everything in “Family”' });
  await pick(dialog.getByLabel(/^Space:/), 'Work');
  await pick(dialog.getByLabel(/^Folder:/), 'Archive');
  await dialog.getByRole('button', { name: 'Next' }).click();
  // Everything in a space still asks, as it can't be undone.
  await expect(dialog.getByRole('note')).toContainText('This can’t be undone.');
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('“Family” is empty now', {
    timeout: 60_000,
  });
  await dialog.getByRole('button', { name: 'Delete space…' }).click();
  const deleting = owner.getByRole('dialog', { name: 'Delete this space' });
  await deleting.getByRole('textbox').fill('Family');
  await deleting.getByRole('button', { name: 'Delete for good' }).click();
  await expect(owner.getByRole('link', { name: 'Family', exact: true })).toHaveCount(0);

  // Both Gardens are in Work › Archive, and Seeds' old address opens it there.
  await openSpace(owner, 'Work');
  await openFolder(owner, 'Archive');
  await expect(owner.getByRole('treeitem', { name: /Garden/ })).toHaveCount(2);
  await owner.goto(oldAddress);
  await expect(owner.getByText('Sow thinly.')).toBeVisible();
  await expect(owner.getByText('This page moved to Work.')).toBeVisible();
});
