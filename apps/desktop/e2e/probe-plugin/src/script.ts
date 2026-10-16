// A script that tries the network and saving a draft, each ending by
// throwing what happened, so the page's plugin notice shows it to the test;
// and one that appends a line to the draft shown, through its page handle.
// It runs from a `data:` address in the host frame, so the app's API is
// named in full.
import { defineScript } from '@wikistow/plugin-sdk';

const outcome = (error: unknown) => (error instanceof Error ? error.message : String(error));

defineScript((host) => {
  host.commands.register({
    id: 'network',
    title: 'Try the network',
    async run() {
      let result: string;
      try {
        result = `reached it (${(await fetch('app://wikistow/api/me')).status})`;
      } catch (error) {
        result = `blocked: ${outcome(error)}`;
      }
      throw new Error(`${host.pluginId}: network ${result}`);
    },
  });
  host.commands.register({
    id: 'append',
    title: 'Append a line',
    async run({ page }) {
      if (!page.edit) throw new Error('append refused: not the draft view');
      const read = await page.read();
      await page.edit({ markdown: `${read.markdown.trimEnd()}\n\nAppended by the probe.\n` });
    },
  });
  host.commands.register({
    id: 'write',
    title: 'Save a draft here',
    async run({ page }) {
      let result: string;
      try {
        const read = await host.pages.read(page.page);
        await host.pages.saveDraft(page.page, {
          base: read.revision,
          markdown: `${read.markdown}\n\nThe probe wrote this.\n`,
        });
        result = 'saved';
      } catch (error) {
        result = `refused: ${outcome(error)}`;
      }
      throw new Error(`write ${result}`);
    },
  });
});
