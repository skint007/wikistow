import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { FindBar, PageFind } from '../src/page/find/find-bar.tsx';
import type { Findable } from '../src/page/find/findable.ts';
import type { Found } from '../src/page/find/match.ts';
import { pageText, readText } from '../src/page/find/page-text.ts';

// Find on page over a page as read, in Chromium: what it counts and
// highlights, and the bar's keys.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// A page as the reader shows it: its title and body are what's searched.
const PAGE = `
  <h1 data-find-root>Tomato beds</h1>
  <p>Not searched: tomato</p>
  <div data-find-root>
    <div data-find="skip"><dl><dt>crop</dt><dd>tomato</dd></dl></div>
    <p>Plant <strong>tom</strong>atoes in May.</p>
    <p>Water the TOMATOES<br>daily.</p>
    <p><button type="button">Copy tomato</button><span class="sr-only">tomato</span></p>
    <details><summary>More</summary><p>A hidden tomato</p></details>
  </div>
`;

function page(html = PAGE) {
  const article = document.createElement('article');
  article.innerHTML = html;
  document.body.append(article);
  cleanups.push(() => article.remove());
  return article;
}

const rootsOf = (article: Element) => () => [...article.querySelectorAll('[data-find-root]')];

function open(target: Findable) {
  const found: Found[] = [];
  const session = target.open((f) => found.push(f));
  cleanups.push(() => session.end());
  return { session, found, last: () => found.at(-1) };
}

const highlighted = (name: string) =>
  [...(CSS.highlights.get(name)?.values() ?? [])].map((range) =>
    range instanceof Range ? range.toString() : '',
  );

function bar(target: Findable | null) {
  const find = new PageFind();
  if (target) cleanups.push(find.add(target));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<FindBar find={find} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { find, container };
}

const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Find on page"]');
const said = () => document.querySelector('[role="search"] [aria-live]')?.textContent ?? '';

/** Wait for the bar to take the focus, a frame after it opens. */
const focused = () => expect.poll(() => document.activeElement).toBe(field());

describe('the page as read', () => {
  it('finds the title’s and body’s text, across formatting, but not properties, controls or hidden text', () => {
    const article = page();
    const { session, last } = open(pageText(rootsOf(article)));
    session.search({ text: 'tomato', matchCase: false });
    expect(last()).toEqual({ count: 3, current: 0 });
    expect(highlighted('find-match')).toEqual(['Tomato', 'tomato', 'TOMATO']);
    expect(highlighted('find-current')).toEqual(['Tomato']);
  });

  it('never matches from one block into the next, nor over a line break', () => {
    const article = page();
    const { text } = readText(rootsOf(article)());
    expect(text).toContain('\nPlant tomatoes in May.\nWater the TOMATOES\ndaily.\n');
    const { session, last } = open(pageText(rootsOf(article)));
    session.search({ text: 'May. Water', matchCase: false });
    expect(last()?.count).toBe(0);
    session.search({ text: 'tomatoes daily', matchCase: false });
    expect(last()?.count).toBe(0);
  });

  it('matches case when told to, and goes round the matches both ways', () => {
    const article = page();
    const { session, last } = open(pageText(rootsOf(article)));
    session.search({ text: 'TOMATO', matchCase: true });
    expect(last()).toEqual({ count: 1, current: 0 });
    session.search({ text: 'tomato', matchCase: false });
    session.step(-1);
    expect(last()).toEqual({ count: 3, current: 2 });
    expect(highlighted('find-current')).toEqual(['TOMATO']);
    session.step(1);
    expect(last()).toEqual({ count: 3, current: 0 });
  });

  it('searches again as the page changes, staying on the match it was on', async () => {
    const article = page();
    const { session, last } = open(pageText(rootsOf(article)));
    session.search({ text: 'tomato', matchCase: false });
    session.step(1);
    const body = article.querySelectorAll('[data-find-root]')[1]!;
    const added = document.createElement('p');
    added.textContent = 'Tomato soup';
    body.prepend(added);
    await expect.poll(() => last()?.count).toBe(4);
    // Still the body's first match, now second after the soup.
    expect(last()?.current).toBe(2);
  });

  it('takes its highlights away, and selects the match it was on as it’s left', () => {
    const article = page();
    const { session } = open(pageText(rootsOf(article)));
    session.search({ text: 'water', matchCase: false });
    expect(session.leave()).toBe(false);
    session.end();
    expect(CSS.highlights.has('find-match')).toBe(false);
    expect(String(getSelection())).toBe('Water');
  });
});

describe('the find bar', () => {
  it('opens with Ctrl+F, says where it is as it’s typed in, and goes on with Enter', async () => {
    const article = page();
    const opener = document.createElement('button');
    opener.textContent = 'Somewhere';
    document.body.append(opener);
    cleanups.push(() => opener.remove());
    bar(pageText(rootsOf(article)));
    opener.focus();
    await userEvent.keyboard('{Control>}f{/Control}');
    await focused();
    await userEvent.keyboard('tomato');
    expect(said()).toBe('1 of 3');
    await userEvent.keyboard('{Enter}');
    expect(said()).toBe('2 of 3');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}');
    expect(said()).toBe('3 of 3');
    // Matching case, only the lower-case one is left.
    await userEvent.click(document.querySelector('[aria-label="Match case"]')!);
    expect(said()).toBe('1 of 1');
    // Escape closes it, its highlights go, and the focus goes back.
    field()?.focus();
    await userEvent.keyboard('{Escape}');
    expect(field()).toBeNull();
    expect(CSS.highlights.has('find-match')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('opens again with its text selected, searching it again', async () => {
    const article = page();
    const { find } = bar(pageText(rootsOf(article)));
    act(() => find.open());
    await focused();
    await userEvent.keyboard('may');
    await userEvent.keyboard('{Escape}');
    act(() => find.open());
    await focused();
    expect(said()).toBe('1 of 1');
    expect(field()?.selectionStart).toBe(0);
    expect(field()?.selectionEnd).toBe(3);
  });

  it('leaves Ctrl+F in a dialog to it, and has no Replace over the page as read', async () => {
    const article = page();
    bar(pageText(rootsOf(article)));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.append(input);
    document.body.append(dialog);
    cleanups.push(() => dialog.remove());
    input.focus();
    await userEvent.keyboard('{Control>}f{/Control}');
    expect(field()).toBeNull();
    input.blur();
    await userEvent.keyboard('{Control>}f{/Control}');
    await focused();
    expect(document.querySelector('input[aria-label="Replace with"]')).toBeNull();
  });
});
