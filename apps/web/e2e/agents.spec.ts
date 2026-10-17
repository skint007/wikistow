import { expect, pick, serverSnapshot, test } from './fixtures';
import { buildCli, cleanUpCli, cliInstall } from './cli';
import { addAgent, agentsPage } from './enroll';
import { folderMenu, newFolder, openFolder, publishedPageIn, shareDialog } from './sharing';
import { adminTab, expectSource, memberWithVault } from './vault';

let bin = '';
test.beforeAll(async () => {
  test.setTimeout(240_000);
  bin = await buildCli();
});
test.afterAll(cleanUpCli);

const TEXT = {
  published: 'Simmer the stock for an hour.',
  drafted: 'Simmer the stock for an hour. The agent says: add bay leaves.',
  publishedByAgent: 'Simmer the stock for two hours, with bay leaves.',
};

/**
 * One person enrolls the real CLI from their browser, picks a folder for
 * it, sees what it wrote attributed to it, puts it in a group, and revokes it.
 */
test('an agent enrolled from the browser reads, drafts and publishes, then is revoked', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email), 'Pat Person');
  await newFolder(page, 'Kitchen');
  await publishedPageIn(page, 'Kitchen', 'Soup', TEXT.published);
  const cli = await cliInstall(bin);

  await test.step('the CLI and the browser show one fingerprint, then the agent is approved', async () => {
    const enrolled = await addAgent(page, cli, 'kitchen agent', async (dialog) => {
      // Kitchen isn't shared yet, so picking it makes it a share.
      await dialog.getByRole('button', { name: 'Add a folder' }).click();
      await pick(dialog.getByLabel('Folder'), 'Personal › Kitchen — not shared yet');
      await expect(dialog).toContainText('Picking it makes it a share');
      await expect(dialog).toContainText('who will see it in Share');
      await expect(dialog).toContainText('Reader: reads published pages.');
      await pick(dialog.getByLabel('Access'), 'Editor + publish');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      // The form closes once the pick is listed, and focus goes back to its button.
      await expect(dialog.getByRole('button', { name: 'Add a folder' })).toBeFocused();
      await expect(
        dialog.getByRole('listitem').filter({ hasText: 'Personal › Kitchen' }),
      ).toContainText('Editor + publish');
    });
    const card = page.getByRole('listitem', { name: 'kitchen agent', exact: true });
    await expect(card).toContainText('Live');
    await expect(card).toContainText('no edits yet');
    await expect(card.getByLabel('Access to Kitchen')).toHaveText('Editor + publish');
    // The server keeps only a hash of the code, and never saw the fingerprint.
    const stored = JSON.stringify(await serverSnapshot());
    expect(stored).not.toContain(enrolled.code.replace('-', ''));
    expect(stored).not.toContain(enrolled.fingerprint);
    expect(stored).not.toContain(enrolled.fingerprint.replaceAll(' ', ''));
  });

  let pageId = '';
  let spaceId = '';
  await test.step('the CLI reads the page and saves a draft', async () => {
    const spaces = await cli.json(['spaces', 'list']);
    expect(spaces.code, spaces.stderr).toBe(0);
    const [granted] = spaces.answer['spaces'] as { spaceId: string; name: string }[];
    expect(granted?.name).toBe('Kitchen');
    spaceId = granted?.spaceId ?? '';
    const tree = await cli.json(['tree', '--space', spaceId]);
    const pages = tree.answer['pages'] as { id: string; title: string; draftHead: string }[];
    const soup = pages.find((p) => p.title === 'Soup');
    pageId = soup?.id ?? '';
    const read = await cli.json(['page', 'read', pageId, '--draft']);
    expect(read.code, read.stderr).toBe(0);
    expect(read.answer['markdown']).toBe(TEXT.published);
    const drafted = await cli.json(
      ['page', 'draft', pageId, '--base', String(read.answer['revisionId']), '--file', '-'],
      TEXT.drafted,
    );
    expect(drafted.code, drafted.stderr).toBe(0);
    // What the agent wrote reaches the server sealed.
    expect(JSON.stringify(await serverSnapshot())).not.toContain('add bay leaves');
  });

  await test.step('the browser opens the agent’s draft', async () => {
    await page.getByRole('link', { name: 'Personal' }).click();
    const activity = page.getByRole('region', { name: 'Agent activity' });
    await openFolder(page, 'Kitchen');
    await page.getByRole('treeitem', { name: 'Soup' }).click();
    await activity.click();
    await expectSource(page, TEXT.drafted);
    await page.getByRole('button', { name: 'Done' }).click();
  });

  await test.step('the agent publishes, and history says it published for its person', async () => {
    const tree = await cli.json(['tree', '--space', spaceId]);
    const soup = (
      tree.answer['pages'] as { id: string; draftHead: string; publishedHead: string }[]
    ).find((p) => p.id === pageId);
    const drafted = await cli.json(
      ['page', 'draft', pageId, '--base', soup?.draftHead ?? '', '--file', '-'],
      TEXT.publishedByAgent,
    );
    const published = await cli.json([
      'page',
      'publish',
      pageId,
      '--revision',
      String(drafted.answer['revisionId']),
      '--base-published',
      soup?.publishedHead ?? 'none',
    ]);
    expect(published.code, published.stderr).toBe(0);

    await page.getByRole('link', { name: 'Personal' }).click();
    await page.getByRole('treeitem', { name: 'Soup' }).click();
    await expect(page.getByText(TEXT.publishedByAgent)).toBeVisible();
    // Its edit is the publication now, so there is no pill.
    await expect(page.getByText('🤖')).toHaveCount(0);
    await page.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('dialog', { name: 'History' });
    await expect(history.getByRole('listitem').first()).toContainText('Version 2');
    await expect(history.getByRole('listitem').first()).toContainText('kitchen agent (for you)');
    await page.keyboard.press('Escape');
  });

  await test.step('a group Pat puts it in shows in its spaces list', async () => {
    await newFolder(page, 'Pantry');
    await page.getByRole('button', { name: 'Space menu' }).click();
    await page.getByRole('menuitem', { name: 'Groups' }).click();
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Cooks');
    await page.getByRole('button', { name: 'Create group' }).click();

    await folderMenu(page, 'Pantry', 'Share…');
    const sharing = shareDialog(page, 'Pantry');
    await sharing.getByLabel('Email or group').fill('Coo');
    await sharing
      .getByRole('list', { name: 'Groups' })
      .getByRole('button', { name: /Cooks/ })
      .click();
    await sharing.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(
      sharing.getByRole('region', { name: 'People with access' }).getByLabel('Access for Cooks'),
    ).toHaveText('Reader', { timeout: 30_000 });
    await page.keyboard.press('Escape');

    // Pat's own agent is confirmed as it is added, and sealed the group's folder.
    await page.getByRole('button', { name: 'Space menu' }).click();
    await page.getByRole('menuitem', { name: 'Groups' }).click();
    await page.getByRole('link', { name: 'Cooks' }).click();
    await page.getByRole('button', { name: 'Add agent' }).click();
    await page
      .getByRole('dialog', { name: 'Add agent' })
      .getByRole('listitem')
      .filter({ hasText: 'kitchen agent' })
      .getByRole('button', { name: 'Add' })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      'kitchen agent is in the group, with its folders.',
    );
    const spaces = await cli.json(['spaces', 'list']);
    expect(spaces.code, spaces.stderr).toBe(0);
    const names = (spaces.answer['spaces'] as { name: string; role: string }[]).map(
      (s) => `${s.name} ${s.role}`,
    );
    expect(names.sort()).toEqual(['Kitchen editor', 'Pantry reader']);
  });

  await test.step('revoking it ends its credential, and the folders can get new keys', async () => {
    await agentsPage(page);
    const card = page.getByRole('listitem', { name: 'kitchen agent', exact: true });
    await expect(card).toContainText(/last edit (just now|\d+ min)/);
    await expect(card.getByRole('region', { name: 'Through groups' })).toContainText('Pantry');
    await card.getByRole('button', { name: 'Revoke' }).click();
    const dialog = page.getByRole('dialog', { name: 'Revoke kitchen agent?' });
    await expect(dialog).toContainText('stops working at once');
    await expect(dialog).toContainText('It keeps the keys it already has');
    const held = dialog.getByRole('region', { name: 'Folders it could read' });
    await expect(held).toContainText('Kitchen');
    await expect(held).toContainText('Pantry');
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    const done = page.getByRole('dialog', { name: 'kitchen agent is revoked' });
    await expect(done).toBeVisible();
    const status = await cli.json(['agent', 'status']);
    expect(status.code, status.stdout).toBe(6);

    await done
      .getByRole('listitem')
      .filter({ hasText: 'Kitchen' })
      .getByRole('button', { name: 'Rotate keys' })
      .click();
    const rotating = page.getByRole('dialog', { name: 'New keys for “Kitchen”' });
    await rotating.getByRole('button', { name: 'Rotate keys' }).click();
    await expect(rotating).toBeHidden({ timeout: 30_000 });
    // Back to the list, with that folder done.
    await expect(done.getByRole('listitem').filter({ hasText: 'Kitchen' })).toContainText(
      'New keys made',
    );
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('listitem', { name: 'kitchen agent', exact: true })).toContainText(
      'Revoked',
    );
  });
});
