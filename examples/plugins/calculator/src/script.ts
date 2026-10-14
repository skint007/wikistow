// A script plugin, in a worker with no network: it declares a block's
// fields and outputs, the app draws them as a form, and `calculate` runs
// here. A page holds the block as text the app reads and writes:
//
//   ```plugin:calculator/product
//   quantity: 2
//   price: 3.5
//   ```
import { blockLanguage, defineScript } from '@wikistow/plugin-sdk';

defineScript((host) => {
  host.blocks.register({
    type: 'product',
    fields: {
      quantity: { type: 'number', label: 'Quantity', default: 1, min: 0 },
      price: { type: 'number', label: 'Unit price', default: 0, min: 0 },
    },
    outputs: {
      total: { label: 'Total', calculate: ({ quantity, price }) => quantity * price },
    },
  });

  // Adding the block is the person's own edit, through the page in front of them.
  host.commands.register({
    id: 'insert-product',
    title: 'Add a product calculator',
    async run({ page }) {
      if (!page.edit) throw new Error('Open the draft to add a product calculator');
      const { markdown } = await page.read();
      const fence = `\`\`\`${blockLanguage(host.pluginId, 'product')}\nquantity: 1\nprice: 0\n\`\`\``;
      await page.edit({ markdown: `${markdown.trimEnd()}\n\n${fence}\n` });
    },
  });
});
