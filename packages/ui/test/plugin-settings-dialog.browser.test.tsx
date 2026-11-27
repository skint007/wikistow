import type { SettingsViewProps } from '@wikistow/plugin-sdk';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { PluginRow } from '../src/plugins/plugin-settings.tsx';
import { PluginsContext, usePlugins, type PluginRuntime } from '../src/plugins/runtime.ts';
import { vaultStore } from '../src/vault/store.ts';
import { openVault } from './page-view.ts';
import { testRuntime } from './plugin-runtime.ts';

// A plugin's Settings opens a dialog (#758), titled with its name, holding
// the fields its manifest declares and then its own sections. The row keeps
// only the button. Each field saves as it is committed, a text field still
// being typed in too when the dialog goes, and `?plugin=` opens it at once.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

// The vault starts locked; the test of that goes first, and the rest open
// it once, since the stand-in keys can't be closed or opened again.
let opened = false;

/** Each view drawn into the plugin's section, with the props it was given. */
const sections: SettingsViewProps[] = [];
/** How wide each drawing found its section as it drew, as for sizing a canvas. */
const widths: number[] = [];

async function draw(at = '/settings/plugins', { open = true } = {}) {
  if (open && !opened) {
    openVault();
    opened = true;
  }
  const made = await testRuntime([
    {
      id: 'tuned',
      settings: [
        { key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello' },
        { key: 'speed', label: 'Speed', type: 'number', default: 5, min: 1, max: 10 },
      ],
      activate: (host) =>
        void host.ui.register('settings.section', {
          id: 'more',
          title: 'More options',
          view: (element, props) => {
            sections.push(props);
            const button = document.createElement('button');
            button.textContent = 'A plugin button';
            element.append(button);
            widths.push(element.parentElement!.getBoundingClientRect().width);
          },
        }),
    },
  ]);
  const root = createRootRoute({ component: Outlet });
  const plugins = createRoute({
    getParentRoute: () => root,
    path: '/settings/plugins',
    validateSearch: z.object({ plugin: z.string().optional() }),
    component: () => (
      <ul>
        {usePlugins().plugins.map((status) => (
          <PluginRow
            key={status.plugin.manifest.id}
            status={status}
            onEnabled={() => {}}
            onRemove={() => {}}
          />
        ))}
      </ul>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([plugins]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const react = createRoot(container);
  const render = () =>
    react.render(
      <PluginsContext value={made.runtime}>
        <RouterProvider router={router} />
      </PluginsContext>,
    );
  await act(async () => render());
  await expect.poll(() => row()).not.toBeNull();
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => react.unmount());
    container.remove();
  };
  unmounts.push(unmount);
  return { ...made, router, unmount };
}

const row = () => document.querySelector<HTMLElement>('li[aria-label=tuned]');
const button = () =>
  [...row()!.querySelectorAll('button')].find((item) => item.textContent === 'Settings')!;
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
const field = (label: string) =>
  [...dialog()!.querySelectorAll('label')].find((item) => item.textContent === label)!
    .control as HTMLInputElement;
const saved = (runtime: PluginRuntime) => () => runtime.settings(runtime.get().plugins[0]!.plugin);

/** Each change the app sends from now on, each after `first` settles. */
function sends(runtime: PluginRuntime, first: Promise<unknown> = Promise.resolve()) {
  const sent: unknown[] = [];
  const update = runtime.updateSettings.bind(runtime);
  runtime.updateSettings = (plugin, change) => {
    sent.push(change);
    return first.then(() => update(plugin, change));
  };
  return sent;
}

it('says to unlock the vault in the dialog while it is locked', async () => {
  await draw('/settings/plugins', { open: false });
  expect(vaultStore.get().status).not.toBe('unlocked');
  await act(() => userEvent.click(button()));
  expect(dialog()!.textContent).toContain('Unlock your vault to change its settings.');
  // Its own section still draws.
  expect(dialog()!.textContent).toContain('A plugin button');
});

it('opens the settings in a dialog, and closing it leaves the row as it was', async () => {
  await draw();
  const before = row()!.innerHTML;
  expect(button().getAttribute('aria-haspopup')).toBe('dialog');
  expect(dialog()).toBeNull();

  await act(() => userEvent.click(button()));
  const shown = dialog()!;
  expect(document.getElementById(shown.getAttribute('aria-labelledby')!)?.textContent).toBe(
    'tuned settings',
  );
  // The declared fields, then the plugin's own section, which it draws.
  expect(field('Greeting').value).toBe('Hello');
  expect(field('Speed').value).toBe('5');
  const section = shown.querySelector('section[aria-label="More options"]')!;
  expect(section.textContent).toContain('A plugin button');
  expect(sections.at(-1)?.settings).toBeDefined();
  // None of it in the row itself, around the dialog.
  const outside = (selector: string) =>
    [...row()!.querySelectorAll(selector)].filter((item) => !item.closest('dialog'));
  expect(outside('input')).toHaveLength(0);
  expect(outside('section')).toHaveLength(0);

  // Its own section takes focus as any part of the dialog does.
  // Drawn once the dialog shows, so it measures the box it is in.
  expect(widths.at(-1)).toBeGreaterThan(0);
  const inSection = section.querySelector('button')!;
  inSection.focus();
  expect(document.activeElement).toBe(inSection);

  await act(() => userEvent.keyboard('{Escape}'));
  expect(dialog()).toBeNull();
  expect(row()!.innerHTML).toBe(before);
  // Focus goes back to the button that opened it.
  expect(document.activeElement).toBe(button());
});

it('saves a change, as it is committed and when the dialog closes on a field', async () => {
  const { runtime } = await draw();
  await act(() => userEvent.click(button()));
  await act(() => userEvent.fill(field('Speed'), '7'));
  await act(() => userEvent.keyboard('{Enter}'));
  await expect.poll(saved(runtime)).toMatchObject({ speed: 7 });

  // Typed, then the dialog closed by its button with no blur or Enter first.
  const sent = sends(runtime);
  await act(() => userEvent.fill(field('Greeting'), 'Hi there'));
  const close = [...dialog()!.querySelectorAll('button')].find(
    (item) => item.textContent === 'Close',
  )!;
  await act(() => userEvent.click(close));
  expect(dialog()).toBeNull();
  await expect.poll(saved(runtime)).toMatchObject({ greeting: 'Hi there', speed: 7 });

  // And by Escape, while the field has focus.
  await act(() => userEvent.click(button()));
  await act(() => userEvent.fill(field('Greeting'), 'Hey'));
  await act(() => userEvent.keyboard('{Escape}'));
  expect(dialog()).toBeNull();
  await expect.poll(saved(runtime)).toMatchObject({ greeting: 'Hey' });
  // Each once, though closing blurs the field and then takes it away.
  expect(sent).toEqual([{ greeting: 'Hi there' }, { greeting: 'Hey' }]);
});

it('saves what was typed when the page goes while the dialog is open', async () => {
  const { runtime, unmount } = await draw();
  await act(() => userEvent.click(button()));
  // A number out of its range isn't saved, closing or not.
  await act(() => userEvent.fill(field('Speed'), '99'));
  await act(() => userEvent.fill(field('Greeting'), 'Bye'));
  const sent = sends(runtime);
  unmount();
  await expect.poll(saved(runtime)).toMatchObject({ greeting: 'Bye' });
  expect(saved(runtime)()['speed']).toBe(5);
  // Once, though the field may be blurred as it goes.
  expect(sent).toEqual([{ greeting: 'Bye' }]);
});

it('opens the dialog at once for ?plugin=, and forgets the search', async () => {
  const { router } = await draw('/settings/plugins?plugin=tuned');
  await expect.poll(() => dialog()).not.toBeNull();
  expect(field('Greeting').value).toBe('Hello');
  await expect.poll(() => router.state.location.search).toEqual({});
});

it('sends an edit once, though Enter sent it and Close blurs it before it lands', async () => {
  const { runtime } = await draw();
  let land = () => {};
  const sent = sends(runtime, new Promise<void>((resolve) => (land = resolve)));
  await act(() => userEvent.click(button()));
  await act(() => userEvent.fill(field('Greeting'), 'Once'));
  await act(() => userEvent.keyboard('{Enter}'));
  const close = [...dialog()!.querySelectorAll('button')].find(
    (item) => item.textContent === 'Close',
  )!;
  await act(() => userEvent.click(close));
  land();
  await expect.poll(saved(runtime)).toMatchObject({ greeting: 'Once' });
  expect(sent).toEqual([{ greeting: 'Once' }]);
});

it('keeps what is typed again when an earlier save lands', async () => {
  const { runtime } = await draw();
  let land = () => {};
  sends(runtime, new Promise<void>((resolve) => (land = resolve)));
  await act(() => userEvent.click(button()));
  await act(() => userEvent.fill(field('Greeting'), 'First'));
  await act(() => userEvent.keyboard('{Escape}'));
  // Opened again before it landed: the field shows the value stored.
  await act(() => userEvent.click(button()));
  expect(field('Greeting').value).toBe('Hello');
  await act(() => userEvent.fill(field('Greeting'), 'Second'));
  await act(async () => land());
  await expect.poll(saved(runtime)).toMatchObject({ greeting: 'First' });
  expect(field('Greeting').value).toBe('Second');
  // And a value landing on a field not typed in since shows it.
  await act(() => userEvent.keyboard('{Enter}'));
  await expect.poll(saved(runtime)).toMatchObject({ greeting: 'Second' });
  expect(field('Greeting').value).toBe('Second');
});

it('says in the row why a save failed once the dialog has closed', async () => {
  const { runtime } = await draw();
  runtime.updateSettings = () => Promise.reject(new Error('Settings can be at most 16 KB.'));
  await act(() => userEvent.click(button()));
  await act(() => userEvent.fill(field('Greeting'), 'Too long'));
  await act(() => userEvent.keyboard('{Escape}'));
  await expect
    .poll(() => row()!.querySelector('[role=alert]')?.textContent)
    .toBe('A setting wasn’t saved: Settings can be at most 16 KB.');
  // Opened again, the dialog says so instead.
  await act(() => userEvent.click(button()));
  expect(dialog()!.textContent).toContain('Settings can be at most 16 KB.');
  expect(
    [...row()!.querySelectorAll('[role=alert]')].filter((item) => !item.closest('dialog')),
  ).toHaveLength(0);
});
