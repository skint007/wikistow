import { act, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';
import changelog from '../../../CHANGELOG.md?raw';
import { parseChangelog } from '../src/whats-new/changelog.ts';

// What's new goes to any release from one field (#757), however many
// releases there are: by mouse, by the arrows, or by Enter on what's typed.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { releases } = parseChangelog(changelog);
// An older release than the newest, as a pill used to be.
const older = releases.find((release) => !release.prerelease && release !== releases[0])!;
vi.stubGlobal('__APP_VERSION__', older.version);
const { Route } = await import('../src/routes/_app/whats-new.tsx');
const WhatsNew = Route.options.component as ComponentType;

let unmount = () => {};
beforeEach(async () => {
  const container = document.createElement('div');
  container.style.height = '600px';
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<WhatsNew />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
});
afterEach(() => unmount());

const field = () => document.querySelector<HTMLInputElement>('#release-finder')!;
const release = (version: string) => document.getElementById(`v${version}`) as HTMLDetailsElement;
const options = () => [...document.querySelectorAll<HTMLElement>('[role=option]')];
const option = (version: string) =>
  options().find((item) => item.firstElementChild?.textContent === version)!;

function expectOpenedAt(version: string) {
  expect(release(version).open).toBe(true);
  expect(document.activeElement).toBe(release(version).querySelector('summary'));
  // Done with, it empties and closes.
  expect(field().value).toBe('');
  expect(options()).toHaveLength(0);
}

it('shows one field in place of a pill for each release', () => {
  expect(releases.length).toBeGreaterThan(20);
  const nav = document.querySelector('nav[aria-label=Releases]')!;
  expect(nav.querySelectorAll('button')).toHaveLength(0);
  expect(field().labels?.[0]?.textContent).toBe('Go to a release');
  expect(field().getAttribute('role')).toBe('combobox');
  // Only the newest is open to begin with.
  expect(release(older.version).open).toBe(false);
});

it('lists each release with its date and marks, and opens the one clicked', async () => {
  await act(() => userEvent.click(field()));
  // The combobox draws the first 100 until something is typed.
  expect(options()).toHaveLength(Math.min(releases.length, 100));
  expect(option(older.version).textContent).toContain('This version');
  const beta = releases.find((item) => item.prerelease);
  if (beta) expect(option(beta.version).textContent).toContain('Prerelease');
  await act(() => userEvent.click(option(older.version)));
  expectOpenedAt(older.version);
});

it('narrows the list as a version is typed, and the arrows and Enter open one', async () => {
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(older.version));
  expect(options().length).toBeLessThan(releases.length);
  expect(options()[0]!.firstElementChild?.textContent).toBe(older.version);
  await act(() => userEvent.keyboard('{ArrowDown}{Enter}'));
  expectOpenedAt(older.version);
});

it('opens the first release listed on Enter, with none reached by the arrows', async () => {
  const last = releases.at(-1)!;
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(`${last.version}{Enter}`));
  expectOpenedAt(last.version);
  // Something matching none leaves the field as typed.
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard('no such release{Enter}'));
  expect(field().value).toBe('no such release');
});

it('starts again from every release after the field is left, with none chosen', async () => {
  // A release with its beta listed after it.
  const stable = releases.find(
    (item) =>
      !item.prerelease && releases.some((other) => other.version.startsWith(`${item.version}-`)),
  )!;
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(`${stable.version}{ArrowDown}{ArrowDown}{Escape}`));
  // Opened again, Enter goes by what's typed, not the beta the arrows reached.
  await act(() => userEvent.keyboard('{ArrowDown}'));
  expect(options().length).toBeGreaterThan(1);
  expect(field().getAttribute('aria-activedescendant')).toBeNull();
  await act(() => userEvent.keyboard('{Enter}'));
  expectOpenedAt(stable.version);

  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(older.version));
  // Tab goes past the list, which closes, to the next thing on the page.
  await act(() => userEvent.keyboard('{Tab}'));
  expect(document.activeElement).toBe(document.querySelector('summary'));
  expect(field().value).toBe('');
  await act(() => userEvent.click(field()));
  expect(options()).toHaveLength(Math.min(releases.length, 100));
});

it('keeps the list open for a press in it off the options, as on its scrollbar', async () => {
  await act(() => userEvent.click(field()));
  const status = document.querySelector<HTMLElement>('[role=status]')!;
  await act(() => userEvent.click(status));
  expect(document.activeElement).toBe(field());
  expect(options().length).toBeGreaterThan(0);
});

it('leaves Enter that ends composing text to the text', async () => {
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(releases[0]!.date.slice(0, 4)));
  // As an input method sends it, taking the word composed.
  act(() => {
    field().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
  });
  expect(field().value).toBe(releases[0]!.date.slice(0, 4));
  expect(document.activeElement).toBe(field());
});
