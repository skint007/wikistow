// A layout plugin: a Recent item in the rail, opening a page of its own that
// lists the pages read lately; each page's reading time beside it; and CSS
// (public/reading-room.css) that sets a page's text in a narrower column.
// It needs no page access: its views only read the page shown.
import {
  definePlugin,
  type AppHost,
  type AppViewProps,
  type PageRef,
  type PageViewProps,
} from '@wikistow/plugin-sdk';
import { reactView } from '@wikistow/plugin-sdk/react';
import { useEffect, useState, useSyncExternalStore } from 'react';

type Read = { page: PageRef; title: string };

/** The pages read since the vault opened, latest first, in memory only. */
let recent: readonly Read[] = [];
const listeners = new Set<() => void>();

function remember(read: Read) {
  recent = [read, ...recent.filter((other) => other.page.pageId !== read.page.pageId)].slice(0, 12);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const words = (markdown: string) => markdown.match(/[\p{L}\p{N}’']+/gu)?.length ?? 0;

/** Beside the page: how long it takes to read, counted again when its draft is saved here. */
function ReadingTime({ page, host }: PageViewProps & { host: AppHost }) {
  const [count, setCount] = useState<number | null>(null);
  const [saves, setSaves] = useState(0);
  useEffect(
    () =>
      host.events.on('draft.saved', (event) => {
        if (event.page.pageId === page.page.pageId) setSaves((n) => n + 1);
      }),
    [host, page],
  );
  useEffect(() => {
    let live = true;
    page.read().then(
      (version) => {
        if (!live) return;
        setCount(words(version.markdown));
        remember({ page: page.page, title: version.title });
      },
      // In the draft view, reading fails while the editor is still opening; a save reads again.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [page, saves]);
  if (count === null) return null;
  return (
    <section className="reading-room-time" aria-label="Reading time">
      <strong>{Math.max(1, Math.round(count / 220))} min read</strong>
      <span>{count.toLocaleString()} words</span>
    </section>
  );
}

/** The plugin's page: what was read lately, each opening its page. */
function Recent({ openPage }: AppViewProps) {
  const pages = useSyncExternalStore(subscribe, () => recent);
  if (pages.length === 0) {
    return <p className="reading-room-note">Pages you read show here until the vault locks.</p>;
  }
  return (
    <ul className="reading-room-recent">
      {pages.map(({ page, title }) => (
        <li key={page.pageId}>
          <button type="button" onClick={() => openPage(page)}>
            {title || 'Untitled'}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default definePlugin({
  activate(host) {
    host.ui.register('rail', { id: 'recent', title: 'Recent', icon: '📖', opens: 'recent' });
    host.ui.register('app.view', { id: 'recent', title: 'Recently read', view: reactView(Recent) });

    host.ui.register('page.aside', {
      id: 'reading-time',
      view: reactView((props: PageViewProps) => <ReadingTime {...props} host={host} />),
    });

    // Locking the vault unloads the plugin: forget what was read.
    host.signal.addEventListener('abort', () => {
      recent = [];
    });
  },
});
