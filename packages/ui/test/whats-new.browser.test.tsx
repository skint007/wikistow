import { act, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';
import changelog from '../../../CHANGELOG.md?raw';
import { parseChangelog } from '../src/whats-new/changelog.ts';
import { matchingHighlights } from '../src/whats-new/search.ts';

// What's new goes to any release from one field (#757), however many
// releases there are: by mouse, by the arrows, or by Enter on what's typed;
// and finds a change by the words in its highlights (#771).

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
  expect(field().labels?.[0]?.textContent).toBe('Find a release or a change');
  expect(field().getAttribute('role')).toBe('combobox');
  // Only the newest is open to begin with.
  expect(release(older.version).open).toBe(false);
});

it('lists each release with its date and marks, and opens the one clicked', async () => {
  await act(() => userEvent.click(field()));
  // The combobox draws the first 100 until something is typed.
  expect(options()).toHaveLength(Math.min(releases.length, 100));
  expect(option(older.version).textContent).toContain('This version');
  const date = new Date(`${older.date}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
  expect(option(older.version).textContent).toContain(date);
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
  const typed = releases[0]!.date.slice(0, 4);
  await act(() => userEvent.keyboard(typed));
  // As an input method sends it, taking the word composed: Safari's with
  // key code 229 and `isComposing` false. With an option the arrows reached too.
  for (const composed of [{ isComposing: true }, { keyCode: 229 }]) {
    await act(() => userEvent.keyboard('{ArrowDown}'));
    act(() => {
      field().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...composed }),
      );
    });
    expect(field().value).toBe(typed);
    expect(document.activeElement).toBe(field());
  }
});

it('scrolls only the list to the option the arrows reach, not the page', async () => {
  // The field near the bottom of a short window, its list running past it.
  const top = field().getBoundingClientRect().top;
  document.body.style.paddingTop = `${Math.max(0, window.innerHeight - 60 - top)}px`;
  onTestFinished(() => void (document.body.style.paddingTop = ''));
  await act(() => userEvent.click(field()));
  // As the app's styles make it: a list shorter than its options.
  const list = document.querySelector<HTMLElement>('[role=listbox]')!;
  Object.assign(list.style, { maxHeight: '100px', overflowY: 'auto' });
  const page = document.scrollingElement!;
  const before = page.scrollTop;
  await act(() => userEvent.keyboard('{ArrowDown}'.repeat(10)));
  expect(list.scrollTop).toBeGreaterThan(0);
  const at = options()[9]!.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  expect(at.top).toBeGreaterThanOrEqual(box.top - 1);
  expect(at.bottom).toBeLessThanOrEqual(box.bottom + 1);
  expect(page.scrollTop).toBe(before);
  // And back up to the first.
  await act(() => userEvent.keyboard('{ArrowUp}'.repeat(9)));
  expect(list.scrollTop).toBe(0);
});

// The longest word of a highlight in an older release, and that release.
function wordIn() {
  for (const release of releases.slice(1)) {
    for (const { items } of release.highlights) {
      for (const item of items) {
        const word = item
          .replaceAll('`', '')
          .split(/[^\p{L}]+/u)
          .filter((w) => w.length >= 7)
          .sort((a, b) => b.length - a.length)[0];
        if (word) return { release, item, word: word.toLowerCase() };
      }
    }
  }
  throw new Error('no highlight with a long word');
}

it('finds releases by a word in their highlights, showing the change that matched', async () => {
  const { release: target, word } = wordIn();
  const holding = releases.filter((r) => matchingHighlights(r, [word]).length > 0);
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(word.toUpperCase()));
  expect(options().map((item) => item.firstElementChild?.textContent)).toEqual(
    holding.slice(0, 100).map((r) => r.version),
  );
  // The change itself, its matching word marked, so it can be told apart.
  const shown = option(target.version);
  const first = matchingHighlights(target, [word])[0]!;
  expect(shown.textContent).toContain(first.replaceAll('`', ''));
  expect(shown.querySelector('mark')?.textContent?.toLowerCase()).toBe(word);
  await act(() => userEvent.click(shown));
  expectOpenedAt(target.version);
  // Opened, the matches are marked there, and nowhere else.
  const marks = [...document.querySelectorAll('mark')];
  expect(marks.length).toBeGreaterThan(0);
  for (const mark of marks) {
    expect(release(target.version).contains(mark)).toBe(true);
    expect(mark.textContent?.toLowerCase()).toBe(word);
  }
  // Picked by its version, nothing is marked.
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(`${older.version}{Enter}`));
  expect(document.querySelectorAll('mark')).toHaveLength(0);
});

it('matches every word typed, in any order, and Enter opens the first', async () => {
  const { release: target, item, word } = wordIn();
  const other = item
    .replaceAll('`', '')
    .split(/[^\p{L}]+/u)
    .find((w) => w.length >= 4 && w.toLowerCase() !== word)!;
  const first = releases.find((r) => matchingHighlights(r, [other.toLowerCase(), word]).length);
  expect(first).toBeDefined();
  await act(() => userEvent.click(field()));
  await act(() => userEvent.keyboard(`${word} ${other}`));
  expect(options().some((o) => o.firstElementChild?.textContent === target.version)).toBe(true);
  await act(() => userEvent.keyboard('{Enter}'));
  expectOpenedAt(first!.version);
  expect(release(first!.version).querySelectorAll('mark').length).toBeGreaterThanOrEqual(2);
});
