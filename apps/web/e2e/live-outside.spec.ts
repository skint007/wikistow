// Writers outside a live session (ADR 0015 decision 8, step 7): the real
// CLI, enrolled as the person's agent, saves the page while the person has
// its draft open live. The session folds the agent's save in; where it
// overlaps what the person is typing, the person's text stays and the page
// offers Review. Runs in the `live` project, over HTTP/2.
import type { Page } from '@playwright/test';
import { expect, pick, test } from './fixtures';
import { buildCli, cleanUpCli, cliInstall } from './cli';
import { addAgent } from './enroll';
import { newFolder, openFolder, publishedPageIn } from './sharing';
import { adminTab, expectSource, memberWithVault, saveStatus, sourceOf } from './vault';

let bin = '';
test.beforeAll(async () => {
  test.setTimeout(240_000);
  bin = await buildCli();
});
test.afterAll(cleanUpCli);

type Cli = Awaited<ReturnType<typeof cliInstall>>;

/** The agent saves `markdown` as the page's draft, on the head as it reads it, again if someone saved first. */
async function agentSaves(cli: Cli, pageId: string, markdown: string) {
  for (let tries = 0; tries < 10; tries++) {
    const read = await cli.json(['page', 'read', pageId, '--draft']);
    expect(read.code, read.stderr).toBe(0);
    const drafted = await cli.json(
      ['page', 'draft', pageId, '--base', String(read.answer['revisionId']), '--file', '-'],
      markdown,
    );
    if (drafted.code === 0) return;
    // Someone in the session saved between the read and the write.
    expect(drafted.code, drafted.stderr).toBe(3);
  }
  throw new Error('the agent never landed its save');
}

async function caretAtEndOfFirstLine(page: Page) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+Home');
  await source.press('End');
}

test('an agent’s save during a live session is folded in, and an overlap offers Review', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(360_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newFolder(page, 'Kitchen');
  await publishedPageIn(page, 'Kitchen', 'Soup', 'Simmer the stock.');
  const cli = await cliInstall(bin, { server: new URL(page.url()).origin, selfSigned: true });
  await addAgent(page, cli, 'kitchen agent', async (dialog) => {
    await dialog.getByRole('button', { name: 'Add a folder' }).click();
    await pick(dialog.getByLabel('Folder'), 'Personal › Kitchen — not shared yet');
    await pick(dialog.getByLabel('Access'), 'Editor');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Add a folder' })).toBeFocused();
  });

  const spaces = await cli.json(['spaces', 'list']);
  const [granted] = spaces.answer['spaces'] as { spaceId: string }[];
  const tree = await cli.json(['tree', '--space', granted?.spaceId ?? '']);
  const soup = (tree.answer['pages'] as { id: string; title: string }[]).find(
    (p) => p.title === 'Soup',
  );
  const pageId = soup?.id ?? '';

  await page.getByRole('link', { name: 'Personal' }).click();
  await openFolder(page, 'Kitchen');
  await page.getByRole('treeitem', { name: 'Soup' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expectSource(page, 'Simmer the stock.');

  await test.step('the agent adds a paragraph, and the open page takes it in', async () => {
    await agentSaves(cli, pageId, 'Simmer the stock.\n\nServe hot.');
    await expect
      .poll(() => sourceOf(page), { timeout: 30_000 })
      .toBe('Simmer the stock.\n\nServe hot.');
    await expect(saveStatus(page)).toHaveText('All changes saved', { timeout: 30_000 });
    await expect(page.getByText(/Someone else (saved|changed)/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Merge…' })).toHaveCount(0);
  });

  await test.step('the agent changes what the person is typing in: theirs stays', async () => {
    await caretAtEndOfFirstLine(page);
    // Slowly, so the person is still typing, unsaved, when the agent's save lands.
    const typing = page.keyboard.type(' Add salt to taste, then stir.', { delay: 250 });
    await agentSaves(cli, pageId, 'Simmer the stock for an hour.\n\nServe hot.');
    await typing;
    const note = page.getByRole('note').filter({ hasText: 'changed this page from outside' });
    await expect(note).toContainText('Your agent changed this page from outside', {
      timeout: 30_000,
    });
    await expect(note).toContainText('1 change overlaps yours');
    await expectSource(page, /^Simmer the stock\. Add salt to taste, then stir\.\n\nServe hot\.$/);
    await expect(saveStatus(page)).toHaveText('All changes saved', { timeout: 30_000 });
  });

  await test.step('Review offers that part, and taking the agent’s goes in', async () => {
    const note = page.getByRole('note').filter({ hasText: 'changed this page from outside' });
    await note.getByRole('button', { name: 'Review' }).click();
    const view = page.getByRole('region', { name: /Review your agent’s changes/ });
    await expect(view).toBeVisible();
    await expect(view).toContainText('The live page');
    await expect(view).toContainText('for an hour');
    await view.getByRole('button', { name: 'Use your agent’s' }).click();
    await view.getByRole('button', { name: 'Apply' }).click();
    await expectSource(page, 'Simmer the stock for an hour.\n\nServe hot.');
    await expect(note).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('All changes saved', { timeout: 30_000 });
    expect(await sourceOf(page)).toBe('Simmer the stock for an hour.\n\nServe hot.');
  });
});
