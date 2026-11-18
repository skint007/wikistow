// The script half, in a worker with no network: it reaches pages only
// through `host`, within the page access the person gave the plugin.
import { defineScript, type PageVersion } from '@wikistow/plugin-sdk';

const INDEX = 'Index';

defineScript((host) => {
  // Spans the app draws as one field bound to a property, in the line of
  // text: `plugin:page-tools/done` is a toggle for the page's `done`, and
  // `plugin:page-tools/done reviewed` one for its `reviewed`.
  // `plugin:page-tools/status` picks the page's `status` from a menu.
  host.inline.register({
    type: 'done',
    field: { type: 'boolean', label: 'Done', property: 'done' },
  });
  host.inline.register({
    type: 'status',
    field: {
      type: 'choice',
      label: 'Status',
      property: 'status',
      // Shown on a page without one, so a new page's menu isn't invalid; a visit never sets it.
      default: 'todo',
      options: [
        { value: 'todo', label: 'To do' },
        { value: 'doing', label: 'Doing' },
        { value: 'done', label: 'Done' },
      ],
    },
  });

  host.commands.register({
    id: 'folder-index',
    title: 'Write this folder’s index',
    async run({ page }) {
      const here = await page.read();
      const folder = { spaceId: here.spaceId, folderId: here.folderId };
      const entries = await host.pages.list(folder);
      const titles = entries
        .flatMap((entry) =>
          entry.kind === 'page' && entry.title && entry.title !== INDEX ? [entry.title] : [],
        )
        .sort((a, b) => a.localeCompare(b));
      const markdown = `${titles.map((title) => `- [[${title}]]`).join('\n')}\n`;
      const existing = entries.find((entry) => entry.kind === 'page' && entry.title === INDEX);
      if (existing?.kind !== 'page') {
        await host.pages.create(folder, { title: INDEX, markdown });
        return;
      }
      const index: PageVersion = await host.pages.read({
        spaceId: existing.spaceId,
        pageId: existing.pageId,
      });
      if (index.markdown === markdown) return;
      await host.pages.saveDraft(index, { base: index.revision, markdown });
    },
  });
});
