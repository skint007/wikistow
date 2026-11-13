// Draws an imported vault's ```dataview TABLE and LIST blocks, which the
// manifest's `fences` claims, from host.pages.query, and again whenever
// the index changes in the page's space. Without the plugin they are code.
import {
  definePlugin,
  PluginError,
  type AppHost,
  type BlockProps,
  type PageQueryResult,
  type PageRow,
  type PropertyValue,
} from '@wikistow/plugin-sdk';
import { reactView } from '@wikistow/plugin-sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { readDql, type Column } from './dql';

/** A property's value by name, as `=name` finds it: whatever its case, with `_`, `-` and spaces alike. */
function valueOf(row: PageRow, name: string): PropertyValue | undefined {
  if (Object.hasOwn(row.properties, name)) return row.properties[name];
  const fold = (key: string) => key.toLowerCase().replace(/[_\s-]+/g, ' ');
  const key = Object.keys(row.properties).find((other) => fold(other) === fold(name));
  return key === undefined ? undefined : row.properties[key];
}

const shown = (value: PropertyValue | undefined): string =>
  value === undefined || value === null || value === ''
    ? '—'
    : Array.isArray(value)
      ? value.map((item) => (Array.isArray(item) ? item.join(', ') : String(item))).join(', ')
      : String(value);

function PageLink({ host, row }: { host: AppHost; row: PageRow }) {
  return (
    <a
      href="#"
      onClick={(event) => {
        event.preventDefault();
        void host.app?.navigate({ kind: 'page', ...row.page });
      }}
    >
      {row.title}
    </a>
  );
}

function Results({
  host,
  kind,
  columns,
  result,
}: {
  host: AppHost;
  kind: 'table' | 'list';
  columns: Column[];
  result: PageQueryResult;
}) {
  const caption =
    result.total === result.rows.length
      ? `${result.total} ${result.total === 1 ? 'page' : 'pages'}`
      : `${result.rows.length} of ${result.total} pages`;
  if (kind === 'list') {
    return (
      <figure className="vault-tables">
        <ul>
          {result.rows.map((row) => (
            <li key={row.page.pageId}>
              <PageLink host={host} row={row} />
            </li>
          ))}
        </ul>
        <figcaption>{caption}</figcaption>
      </figure>
    );
  }
  return (
    <figure className="vault-tables">
      <table>
        <thead>
          <tr>
            <th>Page</th>
            {columns.map(({ heading }, i) => (
              <th key={i}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={row.page.pageId}>
              <td>
                <PageLink host={host} row={row} />
              </td>
              {columns.map(({ name }, i) => (
                <td key={i}>{shown(valueOf(row, name))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Query({ host, source, page }: BlockProps & { host: AppHost }) {
  const read = useMemo(() => readDql(source), [source]);
  const [result, setResult] = useState<PageQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState(0);

  // Asked again whenever a page it can read changes in this space.
  useEffect(
    () =>
      host.events.on('index.changed', ({ spaceIds }) => {
        if (spaceIds.includes(page.spaceId)) setChanges((count) => count + 1);
      }),
    [host, page.spaceId],
  );

  useEffect(() => {
    if (!read.ok) return;
    if (!host.pages.query) {
      setError('This app can’t query pages: update WikiStow.');
      return;
    }
    let live = true;
    host.pages.query({ spaceId: page.spaceId, ...read.query }).then(
      (found) => {
        if (!live) return;
        setResult(found);
        setError(null);
      },
      (failure: unknown) => {
        if (!live) return;
        setError(failure instanceof PluginError ? failure.message : 'The query failed.');
      },
    );
    return () => {
      live = false;
    };
  }, [host, read, page.spaceId, changes]);

  const problem = read.ok ? error : read.error;
  if (problem) {
    return (
      <div className="vault-tables">
        <pre>
          <code>{source}</code>
        </pre>
        <p role="note" className="vault-tables-note">
          {problem}
        </p>
      </div>
    );
  }
  if (!read.ok || !result) return <p className="vault-tables-note">Reading the pages…</p>;
  return <Results host={host} kind={read.kind} columns={read.columns} result={result} />;
}

export default definePlugin({
  activate(host) {
    host.blocks.register({
      type: 'query',
      view: reactView((props: BlockProps) => <Query {...props} host={host} />),
    });
  },
});
