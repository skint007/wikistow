// A layout plugin: a Recent item in the rail, opening a page of its own that
// lists the pages read lately; each page's reading time beside it; and CSS
// (public/reading-room.css) that sets a page's text in a narrower column,
// which a button in the desktop app's titlebar turns off and on. Its
// settings, which the manifest declares and the app draws, choose the
// column's width and the reading speed.
// It needs no page access: its views only read the page shown.
import {
  definePlugin,
  type AppHost,
  type AppViewProps,
  type PageRef,
  type PageViewProps,
  type Settings,
  type TitlebarViewProps,
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

/** Words a minute, from the settings: the manifest's default until they are read. */
let speed = 220;
const speedListeners = new Set<() => void>();

/** Take the settings as they are now: the column's width, and the reading speed. */
function apply(settings: Settings) {
  const width = settings['width'];
  document.documentElement.dataset['readingRoomWidth'] = typeof width === 'string' ? width : '';
  const perMinute = settings['wordsPerMinute'];
  speed = typeof perMinute === 'number' ? perMinute : 220;
  for (const listener of speedListeners) listener();
}

const subscribeSpeed = (listener: () => void) => {
  speedListeners.add(listener);
  return () => {
    speedListeners.delete(listener);
  };
};

/** Beside the page: how long it takes to read, counted again when its draft is saved here. */
function ReadingTime({ page, host }: PageViewProps & { host: AppHost }) {
  const [count, setCount] = useState<number | null>(null);
  const [saves, setSaves] = useState(0);
  const perMinute = useSyncExternalStore(subscribeSpeed, () => speed);
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
      <strong>{Math.max(1, Math.round(count / perMinute))} min read</strong>
      <span>{count.toLocaleString()} words</span>
    </section>
  );
}

/** The plugin's page: what was read lately, each opening its page, and the way to its settings. */
function Recent({ openPage, host }: AppViewProps & { host: AppHost }) {
  const pages = useSyncExternalStore(subscribe, () => recent);
  // An app older than settings refuses the destination, so the link goes.
  const [settings, setSettings] = useState(Boolean(host.settings && host.app));
  const toSettings = settings && (
    <button
      type="button"
      className="reading-room-link"
      onClick={() => host.app?.navigate({ kind: 'settings' }).catch(() => setSettings(false))}
    >
      Reading room settings
    </button>
  );
  if (pages.length === 0) {
    return (
      <>
        <p className="reading-room-note">Pages you read show here until the vault locks.</p>
        {toSettings}
      </>
    );
  }
  return (
    <>
      <ul className="reading-room-recent">
        {pages.map(({ page, title }) => (
          <li key={page.pageId}>
            <button type="button" onClick={() => openPage(page)}>
              {title || 'Untitled'}
            </button>
          </li>
        ))}
      </ul>
      {toSettings}
    </>
  );
}

/** The narrow column is on unless `<html>` carries `data-reading-room-wide`. */
const WIDE = 'data-reading-room-wide';

/** In the desktop titlebar: the narrow column, on or off. */
function ColumnToggle() {
  const [narrow, setNarrow] = useState(() => !document.documentElement.hasAttribute(WIDE));
  return (
    <button
      type="button"
      className="reading-room-toggle"
      aria-label="Narrow column"
      aria-pressed={narrow}
      title="Narrow column"
      onClick={() => {
        document.documentElement.toggleAttribute(WIDE, narrow);
        setNarrow(!narrow);
      }}
    >
      📖
    </button>
  );
}

export default definePlugin({
  activate(host) {
    host.ui.register('rail', { id: 'recent', title: 'Recent', icon: '📖', opens: 'recent' });
    host.ui.register('app.view', {
      id: 'recent',
      title: 'Recently read',
      view: reactView((props: AppViewProps) => <Recent {...props} host={host} />),
    });

    // Its settings now, and as they change in Settings. An older app has none.
    void host.settings?.get().then(apply, () => {});
    host.settings?.on('changed', apply);

    host.ui.register('page.aside', {
      id: 'reading-time',
      view: reactView((props: PageViewProps) => <ReadingTime {...props} host={host} />),
    });

    host.ui.register('app.titlebar', {
      id: 'column',
      view: reactView<TitlebarViewProps>(ColumnToggle),
    });

    // Locking the vault unloads the plugin: forget what was read, and the column goes.
    host.signal.addEventListener('abort', () => {
      recent = [];
      document.documentElement.removeAttribute(WIDE);
      delete document.documentElement.dataset['readingRoomWidth'];
    });
  },
});
