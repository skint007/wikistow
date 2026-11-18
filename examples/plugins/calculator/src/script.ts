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
//
// Fields come in other kinds too: a date, a choice, a toggle, and a number
// drawn as a slider, as the stay's are.
//
//   ```plugin:calculator/stay
//   arrive: 2026-12-20
//   leave: 2026-12-23
//   room: double
//   breakfast: true
//   guests: 2
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

  const DAY_MS = 24 * 60 * 60 * 1000;
  const nightly = { single: 80, double: 110 };
  host.blocks.register({
    type: 'stay',
    fields: {
      arrive: { type: 'date', label: 'Arrive' },
      leave: { type: 'date', label: 'Leave' },
      room: {
        type: 'choice',
        label: 'Room',
        options: [
          { value: 'single', label: 'Single' },
          { value: 'double', label: 'Double' },
        ],
        default: 'double',
      },
      breakfast: { type: 'boolean', label: 'Breakfast' },
      guests: { type: 'number', label: 'Guests', default: 2, min: 1, max: 6, slider: true },
    },
    outputs: {
      nights: {
        label: 'Nights',
        calculate({ arrive, leave }) {
          const nights = (Date.parse(leave) - Date.parse(arrive)) / DAY_MS;
          if (nights < 1) throw new Error('Leave after you arrive');
          return nights;
        },
      },
      total: {
        label: 'Total',
        calculate: ({ nights, room, breakfast, guests }) =>
          Number(nights) * (nightly[room] + (breakfast ? 15 * guests : 0)),
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
