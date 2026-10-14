// The app half: a panel and a command, running in WikiStow's page with its trust.
import {
  definePlugin,
  PluginError,
  type AppHost,
  type BlockProps,
  type PanelProps,
  type PageVersion,
} from '@wikistow/plugin-sdk';
import { reactView } from '@wikistow/plugin-sdk/react';
import { useEffect, useState } from 'react';

const words = (markdown: string) => markdown.match(/[\p{L}\p{N}’']+/gu)?.length ?? 0;

const reviewedOn = (version: PageVersion) => {
  const { data } = version;
  return typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof data['reviewed'] === 'string'
    ? data['reviewed']
    : null;
};

function Stats({ page, host }: PanelProps & { host: AppHost }) {
  const [version, setVersion] = useState<PageVersion | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    page.read().then(
      (read) => live && setVersion(read),
      (error: unknown) =>
        live && setNote(error instanceof Error ? error.message : 'Couldn’t read the page'),
    );
    return () => {
      live = false;
    };
  }, [page, reloads]);

  // Saving the draft elsewhere (the editor, another plugin) shows here.
  useEffect(
    () =>
      host.events.on('draft.saved', (event) => {
        if (event.page.pageId === page.page.pageId) setReloads((count) => count + 1);
      }),
    [host, page],
  );

  if (!version) return <p className="page-tools-note">{note ?? 'Reading…'}</p>;
  const count = words(version.markdown);
  const reviewed = reviewedOn(version);

  // A draft change through the page access the person gave: refused without it.
  const markReviewed = async () => {
    setNote(null);
    try {
      const saved = await host.pages.saveDraft(page.page, {
        base: version.revision,
        data: { reviewed: new Date().toISOString().slice(0, 10) },
      });
      setVersion(saved);
      setNote('Marked reviewed in the draft.');
    } catch (error) {
      setNote(error instanceof PluginError ? `${error.code}: ${error.message}` : 'It failed');
    }
  };

  return (
    <div className="page-tools">
      <dl>
        <dt>Words</dt>
        <dd data-testid="page-tools-words">{count}</dd>
        <dt>Reading time</dt>
        <dd>{Math.max(1, Math.round(count / 200))} min</dd>
        <dt>Version</dt>
        <dd>{version.version}</dd>
        <dt>Reviewed</dt>
        <dd data-testid="page-tools-reviewed">{reviewed ?? 'never'}</dd>
      </dl>
      {version.version === 'draft' && (
        <button type="button" onClick={() => void markReviewed()}>
          Mark reviewed
        </button>
      )}
      {note && (
        <p className="page-tools-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

// A ```plugin:page-tools/product fence holds `quantity: 2` and `price: 3.5`
// lines; the block shows them as fields with their product.
const FIELDS = { quantity: 'Quantity', price: 'Unit price' } as const;
type Field = keyof typeof FIELDS;
type Values = Record<Field, string>;

function parse(source: string): Values {
  const values: Values = { quantity: '1', price: '0' };
  for (const line of source.split('\n')) {
    const [key, ...rest] = line.split(':');
    const field = key?.trim();
    if (field === 'quantity' || field === 'price') values[field] = rest.join(':').trim();
  }
  return values;
}

const format = (values: Values) => `quantity: ${values.quantity}\nprice: ${values.price}`;

function Product({ source, setSource }: BlockProps) {
  // In the editor each change is the page's; in the reader it stays here.
  const [values, setValues] = useState(() => parse(source));
  const change = (field: Field, value: string) => {
    const next = { ...values, [field]: value };
    setValues(next);
    setSource?.(format(next));
  };
  const [quantity, price] = [Number(values.quantity), Number(values.price)];
  const valid = values.quantity !== '' && values.price !== '' && Number.isFinite(quantity * price);
  return (
    <div className="page-tools-product">
      {(Object.keys(FIELDS) as Field[]).map((field) => (
        <label key={field}>
          {FIELDS[field]}
          <input
            inputMode="decimal"
            value={values[field]}
            onChange={(event) => change(field, event.target.value)}
          />
        </label>
      ))}
      <output data-testid="page-tools-total">
        Total: {valid ? Number((quantity * price).toFixed(10)) : 'enter two numbers'}
      </output>
    </div>
  );
}

export default definePlugin({
  activate(host) {
    const StatsPanel = reactView((props: PanelProps) => <Stats {...props} host={host} />);
    host.ui.register('page.panel', { id: 'stats', title: 'Page stats', view: StatsPanel });
    host.blocks.register({ type: 'product', view: reactView(Product) });
    host.commands.register({
      id: 'insert-date',
      title: 'Add today’s date',
      async run({ page }) {
        if (!page.edit) throw new PluginError('forbidden', 'Open the draft to add the date');
        const current = await page.read();
        const today = new Date().toISOString().slice(0, 10);
        await page.edit({ markdown: `${current.markdown.trimEnd()}\n\n${today}\n` });
      },
    });
  },
});
