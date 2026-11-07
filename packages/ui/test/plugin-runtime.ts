import { installedPlugin } from '@wikistow/contracts';
import {
  definePlugin,
  PluginError,
  type AppHost,
  type PageHandle,
  type Pages,
} from '@wikistow/plugin-sdk';
import { Manifest } from '@wikistow/plugin-sdk/manifest';
import type { HostMessage, WorkerMessage } from '@wikistow/plugin-sdk/protocol';
import {
  createRuntime,
  type PluginReach,
  type PluginSession,
  type ShownPage,
} from '../src/plugins/runtime.ts';
import { createLocation } from '../src/plugins/location.ts';
import type { LaunchScript } from '../src/plugins/script-worker.ts';
import { memoryStore } from '../src/plugins/store.ts';

// A real plugin runtime for tests, over the in-memory store (#284): plugins'
// code comes from the test, not from files the app serves.

/** A plugin a test runs: its app code, its script, or both. */
export type TestPlugin = {
  id: string;
  /** Its app code's `activate`. */
  activate?: (host: AppHost) => void | Promise<void>;
  /** Its script, as `fakeScript` makes one. */
  script?: LaunchScript;
  /** The block types its manifest claims. */
  blocks?: string[];
  /** The inline code types its manifest claims. */
  inline?: string[];
};

/** A vault session a test opens and locks. */
export function testSession(open = true) {
  let current: object | null = open ? {} : null;
  const listeners = new Set<() => void>();
  const set = (next: object | null) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const session: PluginSession = {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { ...session, open: () => set({}), lock: () => set(null) };
}

export type TestSession = ReturnType<typeof testSession>;

const nowhere = () => Promise.reject(new PluginError('forbidden', 'No pages in this test'));

/** Page operations a plugin can't use. */
export const noPages: Pages = {
  read: nowhere,
  list: nowhere,
  search: nowhere,
  create: nowhere,
  createFolder: nowhere,
  saveDraft: nowhere,
  move: nowhere,
};

/** The handle for the page shown, which can't be read or edited. */
export const shownHandle = (shown: ShownPage): PageHandle => ({
  page: shown.page,
  read: nowhere,
  edit: null,
});

/**
 * A runtime running `plugins`, enabled, started and settled once each has
 * activated (if the session is open). `reach` replaces what they reach.
 */
export async function testRuntime(
  plugins: TestPlugin[],
  {
    session = testSession(),
    ...reach
  }: Partial<Omit<PluginReach, 'code' | 'session'>> & { session?: TestSession } = {},
) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const of = (id: string) => {
    const plugin = byId.get(id);
    if (!plugin) throw new Error(`No test plugin ${id}`);
    return plugin;
  };
  const store = memoryStore({
    plugins: plugins.map(({ id, activate, script, blocks = [], inline }) =>
      installedPlugin({
        manifest: Manifest.parse({
          id,
          name: id,
          version: '1.0.0',
          api: 1,
          ui: activate ? 'ui.js' : undefined,
          script: script ? 'script.js' : undefined,
          blocks,
          inline,
        }),
        key: 'one',
        development: null,
        library: true,
        enabled: true,
      }),
    ),
  });
  const runtime = createRuntime(store, {
    session,
    pages: () => noPages,
    handle: (_caller, shown) => shownHandle(shown),
    changed: () => {},
    location: createLocation(),
    spaces: async () => [],
    ...reach,
    code: {
      app: async ({ manifest }) => ({
        default: definePlugin({ activate: of(manifest.id).activate ?? (() => {}) }),
      }),
      script: ({ manifest }) => {
        const { script } = of(manifest.id);
        if (!script) throw new Error(`${manifest.id} has no script`);
        return script;
      },
    },
  });
  runtime.start();
  /** Settled once the store is listed and each plugin has started. */
  const settled = async () => {
    await runtime.refresh();
    await Promise.all(plugins.map(({ id }) => runtime.started(id)));
  };
  await settled();
  return { runtime, store, session, settled };
}

/**
 * A script that sends `starting` as it starts, then `ready`, and answers
 * each `invoke` with `answer`'s outcome (by default `done`), as a built
 * script's worker would. `sent` holds what the host sent it.
 */
export function fakeScript(
  starting: WorkerMessage[],
  answer: (
    target: Extract<HostMessage, { type: 'invoke' }>['target'],
  ) => Promise<{ error?: string }> = async () => ({}),
) {
  const sent: HostMessage[] = [];
  const launch: LaunchScript = (on) => {
    queueMicrotask(() => {
      for (const message of [...starting, { type: 'ready' } as const]) on.message(message);
    });
    return {
      post(message) {
        sent.push(message);
        if (message.type !== 'invoke') return;
        void answer(message.target).then(({ error }) =>
          on.message({ type: 'done', invocation: message.invocation, error }),
        );
      },
      close: () => {},
    };
  };
  return { launch, sent };
}
