import { readProperties } from '@wikistow/client';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { PropertiesBox, PropertiesEditor, type PropertyKeys } from '../src/page/properties-box.tsx';
import type { LinkScope } from '../src/page/property-value.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';

// The property rows, mounted for real: what they show, and that an edit
// through them changes only the edited value's characters in the block.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A note as Obsidian writes one, with comments and quoting of its own.
const NOTE = `---
# From Obsidian
title: Garlic bread # what it's called
tags:
  - recipe
  - "bread"
cook_time: 25 # minutes
servings: 4
vegetarian: true
created: 2026-10-12
source: https://example.com/garlic-bread
goes_with: "[[Tomato soup]]"
notes: |
  Use fresh garlic.
---
`;

const scope: LinkScope = {
  spaceId: 's-home',
  selfId: 'p-self',
  pages: [{ id: 'p-soup', title: 'Tomato soup', folders: [] }],
  links: new Map(),
  editor: true,
};

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  window.localStorage.clear();
});

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/** Rendered inside a router, as the reader is, so page links have somewhere to go. */
function routed(node: ReactNode) {
  const rootRoute = createRootRoute({ component: () => node });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/s/$spaceId/p/$pageId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
  });
  return <RouterProvider router={router} />;
}

/** The draft's rows over `initial`, keeping each block they hand back. */
async function editor(initial: string, propertyKeys?: PropertyKeys) {
  const blocks: string[] = [];
  function Draft() {
    const [block, setBlock] = useState(initial);
    return (
      <PropertiesEditor
        frontmatter={block}
        scope={scope}
        onChange={(next) => {
          blocks.push(next);
          setBlock(next);
        }}
        onRemove={() => {}}
        onInsert={() => {}}
        propertyKeys={propertyKeys}
      />
    );
  }
  const container = await render(<Draft />);
  return { container, blocks, last: () => blocks.at(-1) };
}

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('dt')].map((dt) => dt.textContent);

function button(container: ParentNode, name: string | RegExp): HTMLElement {
  const found = [
    ...container.querySelectorAll<HTMLElement>('button, [role=menuitem], [role=menuitemradio]'),
  ].find((element) => {
    const text = element.getAttribute('aria-label') ?? element.textContent ?? '';
    return typeof name === 'string' ? text === name : name.test(text);
  });
  if (!found) throw new Error(`No button ${String(name)}`);
  return found;
}

const field = (container: ParentNode, label: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`No field ${label}`);
  return input;
};

/** Open a row's ⋯ menu and pick `item`. */
async function fromMenu(container: HTMLElement, label: string, item: string) {
  await userEvent.click(button(container, `Actions for ${label}`));
  await expect.poll(() => document.querySelector('[role=menu]')).not.toBeNull();
  await userEvent.click(button(document, item));
}

describe('the reader’s property rows', () => {
  it('shows six rows in sentence case, each value as its type, then the rest on asking', async () => {
    const container = await render(routed(<PropertiesBox frontmatter={NOTE} scope={scope} />));
    await expect
      .poll(() => rows(container))
      .toEqual(['Title', 'Tags', 'Cook time', 'Servings', 'Vegetarian', 'Created']);
    const text = () => container.querySelector('dl')?.textContent;
    expect(text()).toContain('recipebread');
    expect(text()).toContain('Oct 12, 2026');
    expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(true);
    await userEvent.click(button(container, 'Show 3 more'));
    expect(rows(container)).toHaveLength(9);
    const soup = container.querySelector<HTMLAnchorElement>('a[href="/s/s-home/p/p-soup"]');
    expect(soup?.textContent).toBe('Tomato soup');
    const source = container.querySelector<HTMLAnchorElement>('a[target=_blank]');
    expect(source?.href).toBe('https://example.com/garlic-bread');
    expect(source?.rel).toBe('noopener noreferrer');
    expect(text()).toContain('Use fresh garlic.');
    await userEvent.click(button(container, 'Show fewer'));
    expect(rows(container)).toHaveLength(6);
  });

  it('shows a block that doesn’t read as properties as its text, saying why', async () => {
    const container = await render(
      <PropertiesBox frontmatter={'---\n- just\n- a list\n---\n'} scope={scope} />,
    );
    expect(container.querySelector('pre')?.textContent).toBe('- just\n- a list');
    expect(container.textContent).toContain('Shown as text:');
    expect(container.querySelector('dl')).toBeNull();
  });

  it('shows nothing for a block with no properties', async () => {
    const container = await render(
      <PropertiesBox frontmatter={'---\n# a comment\n---\n'} scope={scope} />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows a page link to a page the reader can’t open as its text', async () => {
    const container = await render(
      routed(
        <PropertiesBox
          frontmatter={'---\ngoes_with: "[[Secret]]"\n---\n'}
          scope={{ ...scope, editor: false }}
        />,
      ),
    );
    await expect.poll(() => rows(container)).toEqual(['Goes with']);
    expect(container.querySelector('dd')?.innerHTML).toBe('Secret');
  });
});

describe('the draft’s property rows', () => {
  it('changes only the characters of the value typed, its comment kept', async () => {
    const { container, last } = await editor(NOTE);
    await userEvent.click(button(container, /^Cook time: 25/));
    const input = field(container, 'Cook time');
    await userEvent.clear(input);
    await userEvent.type(input, '30{Enter}');
    expect(last()).toBe(NOTE.replace('cook_time: 25 #', 'cook_time: 30 #'));
    // A number stays a number, and the field gives the focus back.
    expect(readProperties(last() ?? '').ok).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Cook time: 30/);
  });

  it('writes nothing for a value left as it was, or put back with Escape', async () => {
    const block = '---\nlimit: .inf\nname: x\n---\n';
    const { container, blocks } = await editor(block);
    await userEvent.click(button(container, /^Limit: \.inf/));
    await userEvent.type(field(container, 'Limit'), '{Enter}');
    await userEvent.click(button(container, /^Name: x/));
    await userEvent.type(field(container, 'Name'), 'yz{Escape}');
    expect(blocks).toEqual([]);
  });

  it('ticks a checkbox, and adds to and takes from a list, in the list’s own style', async () => {
    const { container, last } = await editor(NOTE);
    await userEvent.click(container.querySelector<HTMLElement>('input[aria-label=Vegetarian]')!);
    expect(last()).toBe(NOTE.replace('vegetarian: true', 'vegetarian: false'));
    await userEvent.type(field(container, 'Add to Tags'), 'soup{Enter}');
    expect(last()).toBe(
      NOTE.replace('vegetarian: true', 'vegetarian: false').replace(
        '  - "bread"\n',
        '  - "bread"\n  - soup\n',
      ),
    );
    await userEvent.click(button(container, 'Remove recipe from Tags'));
    expect(last()).toBe(
      NOTE.replace('vegetarian: true', 'vegetarian: false').replace(
        '  - recipe\n  - "bread"\n',
        '  - "bread"\n  - soup\n',
      ),
    );
  });

  it('renames, retypes and removes a property from its menu', async () => {
    const { container, last } = await editor(NOTE);
    await fromMenu(container, 'Servings', 'Rename');
    const name = field(container, 'New name for Servings');
    await userEvent.clear(name);
    await userEvent.type(name, 'portions{Enter}');
    expect(last()).toBe(NOTE.replace('servings: 4', 'portions: 4'));
    // The focus stays on the row, under its new name.
    await expect
      .poll(() => document.activeElement?.getAttribute('aria-label'))
      .toBe('Actions for Portions');
    await fromMenu(container, 'Portions', 'Type');
    await userEvent.click(button(document, 'Text'));
    expect(last()).toBe(NOTE.replace('servings: 4', 'portions: "4"'));
    await fromMenu(container, 'Cook time', 'Remove');
    expect(last()).toBe(
      NOTE.replace('servings: 4', 'portions: "4"').replace('cook_time: 25 # minutes\n', ''),
    );
  });

  it('adds a property at the block’s end, then opens its value', async () => {
    const { container, last } = await editor(NOTE);
    await userEvent.click(button(container, 'Add property'));
    await userEvent.type(field(container, 'New property’s name'), 'rating{Enter}');
    expect(last()).toBe(NOTE.replace('Use fresh garlic.\n', 'Use fresh garlic.\nrating:\n'));
    await userEvent.type(field(container, 'Rating'), '4.5{Enter}');
    expect(last()).toBe(NOTE.replace('Use fresh garlic.\n', 'Use fresh garlic.\nrating: 4.5\n'));
  });

  it('leaves a key as it was, its spaces too, when Rename changes nothing', async () => {
    const { container, blocks } = await editor('---\n"pad ": 1\n---\n');
    await fromMenu(container, 'Pad', 'Rename');
    await userEvent.keyboard('{Enter}');
    expect(blocks).toEqual([]);
  });

  it('puts a date back that was left half typed', async () => {
    const { container, blocks } = await editor(NOTE);
    await userEvent.click(button(container, /^Created: 2026-10-12/));
    const date = field(container, 'Created');
    expect(date.type).toBe('date');
    await userEvent.keyboard('{Backspace}');
    expect(date.validity.badInput).toBe(true);
    await userEvent.keyboard('{Enter}');
    expect(field(container, 'Created')).toBe(date);
    await userEvent.click(container.querySelector('dt')!);
    expect(blocks).toEqual([]);
    expect(button(container, /^Created: 2026-10-12/)).toBeTruthy();
  });

  it('keeps a value with a line break in it out of a one-line field', async () => {
    const { container } = await editor('---\ndesc: "line one\\nline two"\n---\n');
    const value = container.querySelector('dd')!;
    expect(value.textContent).toContain('line one\nline two');
    expect(value.textContent).toContain('It has a line break');
    expect(value.querySelectorAll('button')).toHaveLength(1);
  });

  it('suggests the keys pages near it use that it hasn’t, loading them only once asked', async () => {
    let loads = 0;
    const { container, last } = await editor(NOTE, {
      keys: ['servings', 'cuisine', 'Cook Time'],
      load: () => (loads += 1),
    });
    expect(loads).toBe(0);
    await userEvent.click(button(container, 'Add property'));
    expect(loads).toBe(1);
    const options = () =>
      [...container.querySelectorAll('[role=option]')].map((o) => o.textContent);
    await expect.poll(options).toEqual(['cuisine']);
    await userEvent.click(container.querySelector('[role=option]')!);
    expect(last()).toBe(NOTE.replace('Use fresh garlic.\n', 'Use fresh garlic.\ncuisine:\n'));
  });

  it('says why an edit can’t be made, and refuses a key the block has', async () => {
    const { container, blocks } = await editor('---\nname: x\n---\n');
    await userEvent.click(button(container, 'Add property'));
    await userEvent.type(field(container, 'New property’s name'), 'name{Enter}');
    expect(container.querySelector('[role=alert]')?.textContent).toBe(
      'There is already a property name.',
    );
    expect(blocks).toEqual([]);
  });

  it('shows a value it can’t change in place as read-only, with Edit as text', async () => {
    const { container, last } = await editor(NOTE);
    const notes = [...container.querySelectorAll('dd')].at(-1)!;
    expect(notes.textContent).toContain('Use fresh garlic.');
    expect(notes.textContent).toContain('It is a block of lines.');
    await userEvent.click(button(notes, 'Edit as text'));
    const text = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(text.value).toBe(NOTE.slice(4, -5));
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
    await userEvent.keyboard('!');
    expect(last()).toBe(NOTE.replace('garlic.\n---', 'garlic.!\n---'));
    await userEvent.click(button(container, 'Show as rows'));
    expect(rows(container)).toHaveLength(9);
  });

  it('shows a block that doesn’t read as properties as text, saying why, until asked for rows once it does', async () => {
    const { container, last } = await editor('---\nkey: [unclosed\n---\n');
    const text = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(text.value).toBe('key: [unclosed');
    expect(container.textContent).toContain('Shown as text:');
    expect(() => button(container, 'Show as rows')).toThrow();
    // Typing on once it reads stays in the text.
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
    await userEvent.keyboard(']\nmore: 1');
    expect(last()).toBe('---\nkey: [unclosed]\nmore: 1\n---\n');
    expect(document.activeElement).toBe(text);
    await userEvent.click(button(container, 'Show as rows'));
    expect(rows(container)).toEqual(['Key', 'More']);
  });

  it('turns the focus to the text asked for from a row’s menu, and on from a row removed', async () => {
    const { container } = await editor(NOTE);
    await fromMenu(container, 'Servings', 'Remove');
    await expect.poll(() => document.activeElement?.textContent).toBe('Add property');
    await fromMenu(container, 'Title', 'Edit as text');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Properties as text');
  });

  it('shows a page link as a chip, which a click edits rather than follows', async () => {
    const { container } = await editor(NOTE);
    const chip = button(container, /^Goes with:/);
    expect(chip.querySelector('span')?.textContent).toBe('Tomato soup');
    expect(chip.querySelector('a')).toBeNull();
    await userEvent.click(chip);
    expect(field(container, 'Goes with').value).toBe('[[Tomato soup]]');
  });
});

const links: LinkAssist = {
  pages: [],
  targets: () => null,
  selfId: 'self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

async function pageEditor(initial: string, mode: 'source' | 'visual' | 'split') {
  window.localStorage.setItem('wikistow.editor', mode);
  const ref = createRef<EditorSurfaceHandle>();
  const container = await render(
    <PageEditor
      ref={ref}
      initial={initial}
      onChange={() => {}}
      status={null}
      links={links}
      attachments={{ list: [], url: async () => null }}
      onFiles={() => {}}
    />,
  );
  if (mode !== 'source') {
    await expect.poll(() => container.querySelector('#page-visual')).not.toBeNull();
  }
  if (mode !== 'visual') {
    await expect
      .poll(() =>
        [...container.querySelectorAll('div')].some((div) =>
          div.shadowRoot?.querySelector('.cm-editor'),
        ),
      )
      .toBe(true);
  }
  return { container, ref };
}

describe('a reference in the visual editor', () => {
  it('shows the value beside the code, follows the properties, and leaves the text as written', async () => {
    const page = '---\nservings: 4\n---\nServes `=servings` and `= this.nope`.\n';
    const { container, ref } = await pageEditor(page, 'visual');
    const chip = () =>
      container.querySelector<HTMLElement>('#page-visual [data-hint="servings · property"]');
    await expect.poll(() => chip()?.textContent).toBe('4');
    expect(chip()?.contentEditable).toBe('false');
    const unknown = container.querySelector('#page-visual [data-hint="No property has this name"]');
    expect(unknown?.textContent).toBe('= this.nope');
    expect(ref.current?.read()).toBe(page);
    act(() => ref.current?.replace(page.replace('servings: 4', 'servings: 6')));
    await expect.poll(() => chip()?.textContent).toBe('6');
    expect(ref.current?.read()).toBe(page.replace('servings: 4', 'servings: 6'));
  });
});

describe('completing a reference', () => {
  const page = '---\nservings: 4\ncook_time: 25\n"a.b": 1\n---\nServes \n';

  it('offers the page’s keys after `= in the source editor, writing the closing backtick', async () => {
    const { container, ref } = await pageEditor(page, 'source');
    act(() => ref.current?.focus());
    await userEvent.keyboard('{Control>}{End}{/Control}{ArrowUp}{End}`=se');
    const labels = () =>
      [...container.querySelectorAll('div')].flatMap((div) =>
        [...(div.shadowRoot?.querySelectorAll('.cm-completionLabel') ?? [])].map(
          (l) => l.textContent,
        ),
      );
    await expect.poll(labels).toEqual(['servings']);
    await userEvent.keyboard('{Enter} people');
    await expect
      .poll(() => ref.current?.read())
      .toBe(page.replace('Serves \n', 'Serves `=servings` people\n'));
  });

  it('completes a name typed into in the source editor, its rest and closing backtick kept', async () => {
    const { container, ref } = await pageEditor(
      '---\nservings: 4\n---\nServes `=servngs` people\n',
      'source',
    );
    act(() => ref.current?.focus());
    // After `serv`.
    await userEvent.keyboard(
      '{Control>}{End}{/Control}{ArrowUp}{Home}' + '{ArrowRight}'.repeat(13) + 'i',
    );
    const labels = () =>
      [...container.querySelectorAll('div')].flatMap((div) =>
        [...(div.shadowRoot?.querySelectorAll('.cm-completionLabel') ?? [])].map(
          (l) => l.textContent,
        ),
      );
    await expect.poll(labels).toEqual(['servings']);
    await userEvent.keyboard('{Enter}');
    await expect
      .poll(() => ref.current?.read())
      .toBe('---\nservings: 4\n---\nServes `=servings` people\n');
  });

  it('opens no list for a reference the visual editor’s cursor is merely put in', async () => {
    const page = '---\nservings: 4\n---\nServes `=servings` now.\n';
    const { container, ref } = await pageEditor(page, 'visual');
    await userEvent.click(container.querySelector('#page-visual code')!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('[role=listbox][aria-label=Property]')).toBeNull();
    expect(ref.current?.read()).toBe(page);
  });

  it('offers them in the visual editor too, writing the reference as code', async () => {
    const { container, ref } = await pageEditor(page, 'visual');
    await userEvent.click(container.querySelector('#page-visual p')!);
    await userEvent.keyboard('{End} `= this.co');
    const options = () =>
      [...document.querySelectorAll('[role=listbox][aria-label=Property] [role=option]')].map(
        (option) => option.textContent,
      );
    await expect.poll(options).toEqual(['cook_time25']);
    await userEvent.keyboard('{Enter} minutes');
    await expect
      .poll(() => ref.current?.read())
      .toBe(page.replace('Serves \n', 'Serves `= this.cook_time` minutes\n'));
  });
});

describe('Insert in page', () => {
  for (const mode of ['source', 'visual'] as const) {
    it(`keeps a reference apart from code beside it in the ${mode} editor`, async () => {
      const { container, ref } = await pageEditor('---\nservings: 4\n---\nUse `x`\n', mode);
      act(() => ref.current?.focus());
      await userEvent.keyboard('{Control>}{Home}{/Control}{End}');
      await fromMenu(container, 'Servings', 'Insert in page');
      await expect
        .poll(() => ref.current?.read())
        .toBe('---\nservings: 4\n---\nUse `x` `=servings`\n');
    });
  }

  it('cuts no code span with a selection ending in one, in the source editor', async () => {
    const { container, ref } = await pageEditor(
      '---\nservings: 4\n---\nUse `abcd` now\n',
      'source',
    );
    act(() => ref.current?.focus());
    // `bc` selected.
    await userEvent.keyboard(
      '{Control>}{Home}{/Control}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{ArrowRight}{/Shift}',
    );
    await fromMenu(container, 'Servings', 'Insert in page');
    await expect
      .poll(() => ref.current?.read())
      .toBe('---\nservings: 4\n---\nUse `abcd` `=servings` now\n');
  });

  it('cuts no code span with a selection ending in one, in the visual editor', async () => {
    const { container, ref } = await pageEditor(
      '---\nservings: 4\n---\nUse `abcd` now\n',
      'visual',
    );
    act(() => ref.current?.focus());
    // `bc` selected: in the editor's text, "Use abcd now".
    await userEvent.keyboard(
      '{Control>}{Home}{/Control}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{ArrowRight}{/Shift}',
    );
    await fromMenu(container, 'Servings', 'Insert in page');
    await expect
      .poll(() => ref.current?.read())
      .toBe('---\nservings: 4\n---\nUse `abcd` `=servings` now\n');
  });

  it('puts a reference after a code span the source editor’s cursor is in', async () => {
    const { container, ref } = await pageEditor('---\nservings: 4\n---\nUse `xy` now\n', 'source');
    act(() => ref.current?.focus());
    await userEvent.keyboard(
      '{End}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}',
    );
    await fromMenu(container, 'Servings', 'Insert in page');
    await expect
      .poll(() => ref.current?.read())
      .toBe('---\nservings: 4\n---\nUse `xy` `=servings` now\n');
  });

  it('puts a reference where the cursor is in split’s source side, when that was the side last typed in', async () => {
    const { container, ref } = await pageEditor(
      '---\nservings: 4\n---\nServes\n\nThe end.\n',
      'split',
    );
    const content = await expect
      .poll(() =>
        [...container.querySelectorAll('div')]
          .map((div) => div.shadowRoot?.querySelector<HTMLElement>('.cm-content'))
          .find(Boolean),
      )
      .toBeTruthy()
      .then(() =>
        [...container.querySelectorAll('div')]
          .map((div) => div.shadowRoot?.querySelector<HTMLElement>('.cm-content'))
          .find(Boolean)!,
      );
    content.focus();
    await userEvent.keyboard('{Control>}{End}{/Control} More');
    await fromMenu(container, 'Servings', 'Insert in page');
    await expect
      .poll(() => ref.current?.read())
      // At the end, past the last line break.
      .toBe('---\nservings: 4\n---\nServes\n\nThe end.\n More`=servings`');
  });

  it('puts a reference after a block selected in the visual editor, which typing then leaves', async () => {
    const { container, ref } = await pageEditor(
      '---\nservings: 4\n---\nBefore\n\n---\n\nAfter\n',
      'visual',
    );
    await expect.poll(() => container.querySelector('#page-visual hr')).not.toBeNull();
    await userEvent.click(container.querySelector('#page-visual hr')!);
    await fromMenu(container, 'Servings', 'Insert in page');
    await userEvent.keyboard('x');
    await expect
      .poll(() => ref.current?.read())
      .toMatch(/^---\nservings: 4\n---\nBefore\n\n(\*\*\*|---)\n\n`=servings`xAfter\n$/);
  });

  for (const mode of ['source', 'visual'] as const) {
    it(`puts a reference where the cursor is in the ${mode} editor, typing going on after it`, async () => {
      window.localStorage.setItem('wikistow.editor', mode);
      const ref = createRef<EditorSurfaceHandle>();
      const changes: string[] = [];
      const container = await render(
        <PageEditor
          ref={ref}
          initial={'---\nservings: 4\n---\nServes\n\nThe end.\n'}
          onChange={(markdown) => changes.push(markdown)}
          status={null}
          links={links}
          attachments={{ list: [], url: async () => null }}
          onFiles={() => {}}
        />,
      );
      if (mode === 'visual') {
        await expect.poll(() => container.querySelector('#page-visual')).not.toBeNull();
      } else {
        await expect
          .poll(() =>
            [...container.querySelectorAll('div')].some((div) =>
              div.shadowRoot?.querySelector('.cm-editor'),
            ),
          )
          .toBe(true);
      }
      // The cursor at the first line's end.
      act(() => ref.current?.focus());
      await userEvent.keyboard('{End}');
      await fromMenu(container, 'Servings', 'Insert in page');
      const page = '---\nservings: 4\n---\nServes`=servings`\n\nThe end.\n';
      await expect.poll(() => ref.current?.read()).toBe(page);
      await expect.poll(() => changes.at(-1)).toBe(page);
      // Typing goes on after it, in the editor, as text.
      await userEvent.keyboard(' people');
      await expect
        .poll(() => ref.current?.read())
        .toBe('---\nservings: 4\n---\nServes`=servings` people\n\nThe end.\n');
    });
  }
});
