// A script plugin, in a worker with no network: it declares blocks'
// fields and outputs, the app draws them as forms, and `calculate` runs
// here. A page holds each block as text the app reads and writes:
//
//   ```plugin:calculator/product
//   quantity: 2
//   price: 3.5
//   ```
//
// A field can be tied to one of the page's properties instead, as the
// recipe's Servings is to `servings`: it shows `servings: 4` from the
// frontmatter, and changing it there changes that, so `=servings` in the
// page follows it.
//
//   ```plugin:calculator/recipe
//   serves: 4
//   amount: 500
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

  host.blocks.register({
    type: 'recipe',
    fields: {
      servings: { type: 'number', label: 'Servings', default: 4, min: 1, property: 'servings' },
      serves: { type: 'number', label: 'Recipe serves', default: 4, min: 1 },
      amount: { type: 'number', label: 'Amount', default: 100, min: 0 },
    },
    outputs: {
      scaled: {
        label: 'For your servings',
        calculate: ({ servings, serves, amount }) => Math.round((amount * servings) / serves),
      },
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
