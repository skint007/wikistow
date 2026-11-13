import { PluginError, type AppHost, type PageRef, type PageVersion } from '@wikistow/plugin-sdk';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createLocation, type Place } from '../src/plugins/location.ts';
import type { ShownPage } from '../src/plugins/runtime.ts';
import type { LaunchScript } from '../src/plugins/script-worker.ts';
import { fakeScript, noPages, shownHandle, testRuntime, testSession } from './plugin-runtime.ts';

// The plugin runtime through `createRuntime`, over the in-memory store and
// a fake session (#284): what runs while the session is open, how events
// reach handlers, and the limits a plugin's writes meet.

const PAGE: PageRef = { spaceId: 's', pageId: 'p' };
const SHOWN: ShownPage = { page: PAGE, version: 'draft', revision: 'r1', draft: null };

const version = (page: PageRef, revision: string): PageVersion => ({
  ...page,
  folderId: null,
  title: 'Page',
  markdown: '',
  revision,
  version: 'draft',
  data: null,
});

/** A promise to settle later. */
const gate = () => Promise.withResolvers<void>();

const saved = (page: PageRef, revision: string) =>
  ({ event: 'draft.saved', payload: { page, revision } }) as const;

describe('the plugin runtime', () => {
  it('runs app code and a script while the session is open, and drops what they registered on lock', async () => {
    const hosts: AppHost[] = [];
    const script = fakeScript([
      { type: 'register', command: { id: 'from-script', title: 'From the script' } },
    ]);
    const { runtime, session, settled } = await testRuntime([
      {
        id: 'tools',
        activate(host) {
          hosts.push(host);
          host.commands.register({ id: 'from-app', title: 'From app code', run: () => {} });
        },
        script: script.launch,
      },
    ]);
    // In the order registered: which part starts first varies.
    const commands = () =>
      runtime
        .get()
        .commands.map(({ pluginId, id }) => `${pluginId}/${id}`)
        .toSorted();
    expect(commands()).toEqual(['tools/from-app', 'tools/from-script']);

    // The script's command runs in its worker.
    await runtime.runCommand('tools', 'from-script', SHOWN);
    expect(script.sent).toContainEqual(
      expect.objectContaining({
        type: 'invoke',
        target: { kind: 'command', id: 'from-script', page: PAGE, editable: false, cursor: false },
      }),
    );

    session.lock();
    expect(commands()).toEqual([]);
    expect(hosts[0]?.signal.aborted).toBe(true);
    await settled();
    // Still listed for Settings, not running.
    expect(runtime.get().plugins.map(({ plugin }) => plugin.manifest.id)).toEqual(['tools']);
    await expect(runtime.runCommand('tools', 'from-app', SHOWN)).rejects.toThrow(/isn’t running/);

    session.open();
    await settled();
    expect(hosts).toHaveLength(2);
    expect(commands()).toEqual(['tools/from-app', 'tools/from-script']);
  });

  it('runs one handler at a time per event and page, then only the latest that waited', async () => {
    const runs: string[] = [];
    const busy = gate();
    const { runtime } = await testRuntime([
      {
        id: 'watcher',
        activate(host) {
          host.events.on('draft.saved', async ({ page, revision }) => {
            runs.push(`${page.pageId} ${revision}`);
            await busy.promise;
          });
        },
      },
    ]);
    const other = { ...PAGE, pageId: 'q' };
    for (const event of [saved(PAGE, 'r1'), saved(PAGE, 'r2'), saved(other, 'r1')])
      runtime.deliver(event);
    runtime.deliver(saved(PAGE, 'r3'));
    expect(runs).toEqual(['p r1', 'q r1']);
    busy.resolve();
    await expect.poll(() => runs).toEqual(['p r1', 'q r1', 'p r3']);
  });

  it('tells other plugins of a plugin’s save, not the plugin that saved', async () => {
    const told: string[] = [];
    const hosts = new Map<string, AppHost>();
    const changed: [string, PageRef | undefined][] = [];
    const listener = (id: string) => (host: AppHost) => {
      hosts.set(id, host);
      host.events.on('draft.saved', ({ revision }) => void told.push(`${id} ${revision}`));
    };
    const { runtime } = await testRuntime(
      [
        { id: 'saver', activate: listener('saver') },
        { id: 'other', activate: listener('other') },
      ],
      {
        // As the app's page operations do, telling the runtime of the save.
        pages: (caller) => ({
          ...noPages,
          async saveDraft(page) {
            caller.write();
            caller.wrote(page, 'r2');
            return version(page, 'r2');
          },
        }),
        changed: (spaceId, page) => void changed.push([spaceId, page]),
      },
    );
    await hosts.get('saver')?.pages.saveDraft(PAGE, { base: 'r1', markdown: 'New' });
    await expect.poll(() => told).toEqual(['other r2']);
    expect(changed).toEqual([['s', PAGE]]);
    // The editor's save, for no plugin, is told to both.
    runtime.deliver(saved(PAGE, 'r3'));
    await expect.poll(() => told.toSorted()).toEqual(['other r2', 'other r3', 'saver r3']);
  });

  it('counts page operations and page edits against one write limit', async () => {
    const hosts: AppHost[] = [];
    const { runtime } = await testRuntime(
      [
        {
          id: 'writer',
          activate(host) {
            hosts.push(host);
            host.commands.register({
              id: 'edit',
              title: 'Edit',
              run: async ({ page }) => void (await page.edit?.({ markdown: 'Edited' })),
            });
          },
        },
      ],
      {
        pages: (caller) => ({
          ...noPages,
          async saveDraft(page) {
            caller.write();
            return version(page, 'r2');
          },
        }),
        handle: (caller, shown) => ({
          ...shownHandle(shown),
          async edit() {
            caller.write();
            return version(shown.page, 'r3');
          },
        }),
      },
    );
    const pages = hosts[0]?.pages;
    if (!pages) throw new Error('The plugin didn’t start');
    await runtime.runCommand('writer', 'edit', SHOWN);
    for (let n = 1; n < 30; n += 1) await pages.saveDraft(PAGE, { base: 'r1' });
    const refused = await runtime.runCommand('writer', 'edit', SHOWN).catch((error) => error);
    expect(refused).toBeInstanceOf(PluginError);
    expect(refused).toMatchObject({ code: 'rate-limited' });
  });

  // A script's command has 10 seconds, but a trash prompt waits for the
  // person, and a batch saves about a page a second (#404).
  it('stops a script command’s clock while the person answers its trash prompt', async () => {
    const launch: LaunchScript = (on) => {
      queueMicrotask(() => {
        on.message({ type: 'register', command: { id: 'merge', title: 'Merge' } });
        on.message({ type: 'ready' });
      });
      let invocation = -1;
      return {
        post(message) {
          if (message.type === 'invoke') {
            invocation = message.invocation;
            on.message({ type: 'call', call: 0, method: 'pages.trash', args: [[PAGE]] });
          } else if (message.type === 'answer') on.message({ type: 'done', invocation });
        },
        close: () => {},
      };
    };
    const answer = Promise.withResolvers<boolean>();
    const { runtime } = await testRuntime([{ id: 'refactor', script: launch }], {
      pages: () => ({ ...noPages, trash: () => answer.promise }),
    });
    vi.useFakeTimers();
    try {
      const run = runtime.runCommand('refactor', 'merge', SHOWN);
      await vi.advanceTimersByTimeAsync(30_000);
      answer.resolve(true);
      await expect(run).resolves.toBeUndefined();
      expect(runtime.get().plugins[0]?.problem).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an activation that finishes after the session changed', async () => {
    const opening = [gate(), gate()];
    const signals: AbortSignal[] = [];
    const finished: number[] = [];
    const { runtime, session } = await testRuntime(
      [
        {
          id: 'slow',
          async activate(host) {
            const n = signals.push(host.signal) - 1;
            await opening[n]?.promise;
            host.commands.register({ id: `run-${n}`, title: `Run ${n}`, run: () => {} });
            host.ui.register('page.aside', { id: `aside-${n}`, view: () => {} });
            finished.push(n);
          },
        },
      ],
      { session: testSession(false) },
    );
    session.open();
    await expect.poll(() => signals.length).toBe(1);
    // Locked and opened again while it starts: another activation.
    session.lock();
    session.open();
    await expect.poll(() => signals.length).toBe(2);
    expect(signals[0]?.aborted).toBe(true);

    opening[0]?.resolve();
    await expect.poll(() => finished).toEqual([0]);
    expect(runtime.get().commands).toEqual([]);
    expect(runtime.get().regions['page.aside']).toEqual([]);
    opening[1]?.resolve();
    await runtime.started('slow');
    expect(runtime.get().commands.map(({ id }) => id)).toEqual(['run-1']);
    expect(runtime.get().regions['page.aside'].map(({ id }) => id)).toEqual(['aside-1']);
  });

  it('tells app code where the person is as it changes, and each page shown once', async () => {
    const location = createLocation();
    const at: string[] = [];
    const shownTold: string[] = [];
    const { runtime } = await testRuntime(
      [
        {
          id: 'where',
          activate(host) {
            host.app?.location.subscribe((location) => {
              at.push(JSON.stringify(location));
            });
            host.events.on('page.shown', ({ page, version, revision }) => {
              shownTold.push(`${page.pageId} ${version} ${revision}`);
            });
          },
        },
      ],
      { location },
    );
    location.routed({ kind: 'page', ...PAGE });
    const shown = { page: PAGE, version: 'draft', revision: 'r1' } as const;
    const first = location.showing(shown);
    const opened = [
      '{"kind":"page","spaceId":"s","pageId":"p"}',
      '{"kind":"page","spaceId":"s","pageId":"p","version":"draft"}',
    ];
    await expect.poll(() => at).toEqual(opened);
    // Another revision, in React's order: the old effect ends, then the new one starts.
    first();
    const second = location.showing({ ...shown, revision: 'r2' });
    // The same version shown again, and the router at the same place, tell nothing.
    const close = location.showing({ ...shown, page: { ...PAGE }, revision: 'r2' });
    second();
    location.routed({ kind: 'page', ...PAGE });
    await expect.poll(() => shownTold).toEqual(['p draft r1', 'p draft r2']);
    expect(at).toEqual(opened);
    close();
    location.routed({ kind: 'plugin', pluginId: 'where', viewId: 'home' });
    await expect.poll(() => at.at(-1)).toBe('{"kind":"plugin","pluginId":"where","viewId":"home"}');
    expect(runtime.get().plugins[0]?.problem).toBeNull();
  });

  it('navigates to a plugin’s own pages by its ID, and refuses an event this app lacks', async () => {
    const location = createLocation();
    const went: Place[] = [];
    location.navigateWith(async (to) => void went.push(to));
    const hosts: AppHost[] = [];
    await testRuntime([{ id: 'nav', activate: (host) => void hosts.push(host) }], { location });
    const [host] = hosts;
    if (!host?.app) throw new Error('It didn’t start');
    await host.app.navigate({ kind: 'plugin', viewId: 'home' });
    await host.app.navigate({ kind: 'page', ...PAGE, version: 'published' });
    expect(went).toEqual([
      { kind: 'plugin', pluginId: 'nav', viewId: 'home' },
      { kind: 'page', ...PAGE, version: 'published' },
    ]);
    // @ts-expect-error A plugin built for a newer app may name an event this one lacks.
    expect(() => host.events.on('space.opened', () => {})).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });
});
