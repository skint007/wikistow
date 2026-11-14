import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, pick, test } from './fixtures';
import { adminTab, expectSource, fillSource, memberWithVault, newPage, waitForSave } from './vault';

const BUILD = fileURLToPath(new URL('../../../packages/plugin-sdk/src/build.ts', import.meta.url));
const NOTE_REFACTOR = fileURLToPath(
  new URL('../../../examples/plugins/note-refactor', import.meta.url),
);

/** With E2E_SHOTS set, a screenshot for the pull request, in docs/screenshots/404. */
async function shot(page: Page, name: string) {
  if (!process.env['E2E_SHOTS']) return;
  const path = fileURLToPath(new URL(`../../../docs/screenshots/404/${name}.png`, import.meta.url));
  await page.screenshot({ path });
}

/** Select `text` in the page's source editor, through CodeMirror's view, as `sourceOf` reads it. */
async function selectInSource(page: Page, text: string) {
  await page.locator('#page-source').evaluate((editor, wanted) => {
    type View = {
      state: { sliceDoc(): string };
      dispatch(change: { selection: { anchor: number; head: number } }): void;
      focus(): void;
    };
    const view = (editor as { cmTile?: { root?: { view?: View } } }).cmTile?.root?.view;
    if (!view) throw new Error('No CodeMirror view found from #page-source');
    const at = view.state.sliceDoc().indexOf(wanted);
    if (at < 0) throw new Error(`No “${wanted}” in the source`);
    view.focus();
    view.dispatch({ selection: { anchor: at, head: at + wanted.length } });
  }, text);
}

/** A page's row in the sidebar, which names it with its status after its title. */
const row = (page: Page, title: string) =>
  page.getByRole('treeitem', { name: new RegExp(`^${title}\\b`) });

/** Open a page from the sidebar by its title, in its draft view. */
async function openDraft(page: Page, title: string) {
  await row(page, title).click();
  await expect(page.locator('#page-title')).toHaveValue(title);
  await expect(page.locator('#page-source')).toBeVisible();
}

/**
 * Splitting and merging notes from a plugin (#404), through the
 * `note-refactor` example, a script: a shortcut the person gives its
 * command in Settings → Plugins, a split whose heading's links follow it
 * (`relink`), and a merge whose pages go to the trash after one prompt
 * listing them all (`trash`). The runtime's tests hold the script's clock
 * stopping while it waits (`plugin-runtime.browser`).
 */
test('a plugin splits a note by a shortcut, and merges notes into the trash after one prompt', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  execFileSync(process.execPath, [BUILD, 'build', NOTE_REFACTOR], { stdio: 'inherit' });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const space = page.url();

  const installed = page
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'Note refactor' });
  await test.step('installed and given the space, its commands take shortcuts', async () => {
    await page.goto('/settings/plugins?tab=library');
    await page.getByLabel('Plugin folder').setInputFiles(`${NOTE_REFACTOR}/dist`);
    const approval = page.getByRole('dialog');
    await pick(approval.getByRole('button', { name: /^Who sees it/ }), 'Only me');
    await approval.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByText('Uploaded and installed Note refactor 0.1.0.')).toBeVisible({
      timeout: 15_000,
    });
    await page
      .getByRole('navigation', { name: 'Plugins' })
      .getByRole('link', { name: 'Installed' })
      .click();
    await installed.getByRole('button', { name: /^Where/ }).click();
    await page.getByRole('menuitemradio').first().click();
    await pick(installed.getByRole('button', { name: /^Access/ }), 'Read and write');
    await installed.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(installed.getByRole('list', { name: 'Page access' })).toContainText(
      'read and write',
    );

    const shortcuts = installed.getByRole('region', { name: 'Note refactor shortcuts' });
    await shortcuts
      .getByRole('button', { name: 'Set a shortcut for Split selection into a page' })
      .click();
    // The app's own key is refused, saying whose it is.
    await page.keyboard.press('Control+k');
    await expect(shortcuts.getByRole('alert')).toHaveText('Ctrl+K is the app’s own: Search.');
    await page.keyboard.press('Control+Alt+s');
    await expect(shortcuts.getByRole('alert')).toHaveCount(0);
    await expect(shortcuts.locator('kbd')).toHaveText('Ctrl+Alt+S');
    await shortcuts.scrollIntoViewIfNeeded();
    await shot(page, 'shortcut-settings');
  });

  await test.step('the shortcut splits the selection into a page, and links to its heading follow', async () => {
    await page.goto(space);
    await newPage(page, 'Index');
    await fillSource(page, 'See [[Notes#Soup recipes]] and [[Notes#Bread]].\n');
    await waitForSave(page);
    await newPage(page, 'Notes');
    await fillSource(page, 'Intro.\n\n## Soup recipes\n\nLeek and potato.\n\n## Bread\n\nRye.\n');
    await waitForSave(page);
    await selectInSource(page, '## Soup recipes\n\nLeek and potato.');
    await page.keyboard.press('Control+Alt+s');
    await expectSource(page, 'Intro.\n\n[[Soup recipes]]\n\n## Bread\n\nRye.\n');
    await waitForSave(page);
    await openDraft(page, 'Soup recipes');
    await expectSource(page, 'Leek and potato.\n');
    // Once the command has saved Index, it links here.
    await expect(page.getByRole('region', { name: 'Linked from' })).toContainText('Index', {
      timeout: 15_000,
    });
    await openDraft(page, 'Index');
    await expectSource(page, 'See [[Soup recipes]] and [[Notes#Bread]].\n');
  });

  await test.step('a merge asks once for every page it moves to the trash', async () => {
    await newPage(page, 'Rye');
    await fillSource(page, 'Flour and water.\n');
    await waitForSave(page);
    await newPage(page, 'Cake');
    await fillSource(page, 'Eggs and sugar.\n');
    await waitForSave(page);
    await newPage(page, 'Kitchen');
    await fillSource(page, '[[Rye]]\n[[Cake]]\n');
    await waitForSave(page);
    await selectInSource(page, '[[Rye]]\n[[Cake]]');
    await page.keyboard.press('Control+Shift+P');
    await page.getByRole('combobox').fill('>Merge linked');
    await page.keyboard.press('Enter');

    const prompt = page.getByRole('dialog', { name: 'Move 2 pages to the trash?' });
    await expect(prompt).toContainText('Note refactor asks to move these 2 pages to the trash.');
    await expect(prompt.getByRole('list', { name: 'Pages to move to the trash' })).toHaveText(
      ['Rye', 'Cake'].join(''),
    );
    // Its buttons wait a moment, so a click meant for something else can't answer it.
    await expect(prompt.getByRole('button', { name: 'Move to trash' })).toBeEnabled();
    await shot(page, 'trash-prompt');
    await prompt.getByRole('button', { name: 'Move to trash' }).click();
    await expect(page.getByText('Note refactor moved 2 pages to the trash.')).toBeVisible();
    await expectSource(page, '## Rye\n\nFlour and water.\n\n## Cake\n\nEggs and sugar.\n\n');
    await expect(row(page, 'Rye')).toHaveCount(0);
    await expect(row(page, 'Cake')).toHaveCount(0);
    await page.goto('/trash');
    await expect(page.getByText('Rye', { exact: true })).toBeVisible();
    await expect(page.getByText('Cake', { exact: true })).toBeVisible();
  });
});
