// Splitting and merging notes, as Obsidian's Note Refactor does (#404),
// from a script, in a worker with no network: its only way to pages is
// the host. Give it write access to where it works in Settings → Plugins,
// and a shortcut for each command there if you like.
//
// - **Split selection into a page**: what is selected in the draft becomes
//   a page beside this one, named by its first heading (else its first
//   line), and a link to it takes its place. Links elsewhere to that
//   heading now go to the new page (`host.pages.relink`).
// - **Merge linked pages here**: each page the selection links to goes in
//   place of the selection, under a heading of its title. Links to those
//   pages now come here, to that heading, and the pages go to the trash
//   once you agree, asked once for them all (`host.pages.trash`).
import { defineScript, PluginError, type DraftResult, type PageRef } from '@wikistow/plugin-sdk';

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/;
/** `[[Title]]`, `[[Folder/Title#Heading|text]]`: the page each names. */
const LINKS = /\[\[([^\][|#]+)(?:#[^\][|]*)?(?:\\?\|[^\][]*)?\]\]/g;
/** What a page's title, or a link's heading, can't hold. */
const UNWRITABLE = /[[\]|#\\`<\r\n]/;

/** Text without what a title can't hold, on one line. */
const titled = (text: string) =>
  text
    .replace(/[[\]|#^\\`<]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

/** Say which pages' links couldn't follow, if any: the rest changed. */
function followed(results: DraftResult[]) {
  const failed = results.flatMap((result) => (result.ok ? [] : [result.message]));
  if (failed.length > 0)
    throw new PluginError(
      'failed',
      `Links in ${failed.length} pages stayed as they were: ${failed[0]}`,
    );
}

/** A page's text after its frontmatter. */
const body = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

defineScript((host) => {
  host.commands.register({
    id: 'split',
    title: 'Split selection into a page',
    async run({ page }) {
      const { editor } = page;
      if (!editor) throw new PluginError('invalid', 'Open the page’s draft to split it.');
      const selected = (await editor.selection()).trim();
      if (!selected) throw new PluginError('invalid', 'Select what to move into a page.');
      const [first = '', ...rest] = selected.split('\n');
      const heading = HEADING.exec(first)?.[1] ?? null;
      const title = titled(heading ?? first.replace(/^[>*+\-\s]+/, '')) || 'Split';
      const markdown = heading ? rest.join('\n').trim() : selected;
      const here = await page.read();
      const made = await host.pages.create(
        { spaceId: here.spaceId, folderId: here.folderId },
        { title, markdown: `${markdown}\n` },
      );
      await editor.insert(`[[${made.title}]]`);
      // The heading is the new page's title now: links to it go to the page.
      if (heading && !UNWRITABLE.test(heading))
        followed(
          await host.pages.relink([{ from: { page: page.page, heading }, to: { page: made } }]),
        );
    },
  });

  host.commands.register({
    id: 'merge',
    title: 'Merge linked pages here',
    async run({ page }) {
      const { editor } = page;
      if (!editor) throw new PluginError('invalid', 'Open the page’s draft to merge into it.');
      const selected = await editor.selection();
      const names = [...new Set([...selected.matchAll(LINKS)].map(([, target = '']) => target))];
      if (names.length === 0)
        throw new PluginError('invalid', 'Select links to the pages to merge here.');
      const rows = await host.pages.index(page.page.spaceId);
      const merged: { page: PageRef; title: string }[] = [];
      const parts: string[] = [];
      for (const name of names) {
        const title = (name.split('/').pop() ?? name).trim().toLowerCase();
        const row = rows.find(
          (each) => each.title.toLowerCase() === title && each.page.pageId !== page.page.pageId,
        );
        if (!row) throw new PluginError('not-found', `There’s no page “${name}” to merge.`);
        const read = await host.pages.read(row.page);
        parts.push(`## ${read.title}\n\n${body(read.markdown).trim()}\n`);
        merged.push({ page: row.page, title: read.title });
      }
      await editor.insert(parts.join('\n'));
      // Links to them come here, each to its heading, before they go.
      const relinked = await host.pages.relink(
        merged.map(({ page: from, title }) => ({
          from: { page: from },
          to: { page: page.page, ...(UNWRITABLE.test(title) ? {} : { heading: title }) },
        })),
      );
      await host.pages.trash(merged.map(({ page: each }) => each));
      followed(relinked);
    },
  });
});
