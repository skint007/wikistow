import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { availability, type Waiting } from '../src/shell/availability.ts';
import { FolderMenu, folderActions } from '../src/shell/tree-menus.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** An editor's folder menu, open, with every action recorded as it runs. */
async function openMenu(waiting: Waiting) {
  const ran: string[] = [];
  const run = (name: string) => () => ran.push(name);
  const actions = folderActions({
    onOpen: run('open'),
    editing: {
      onNewPage: run('new page'),
      onNewFromTemplate: run('template'),
      onNewFolder: run('new folder'),
      onRename: run('rename'),
      onRestyle: run('restyle'),
      onSortByName: run('sort by name'),
      ordering: { onMoveUp: run('move up'), onMoveDown: run('move down') },
      onMove: run('move'),
      onCopy: run('copy'),
      onShare: run('share'),
      onDelete: run('delete'),
    },
    onExport: run('export'),
    onImport: run('import'),
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<FolderMenu name="Trips" actions={actions} waiting={waiting} />));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Trips"]');
  if (!trigger) throw new Error('No menu button');
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  });
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const item = (label: string) => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent === label,
    );
    if (!found) throw new Error(`No item ${label}`);
    return found;
  };
  return { ran, item, actions };
}

it('holds each item as its kind says, for a folder made offline', async () => {
  const { ran, item, actions } = await openMenu('made');
  for (const { label, kind } of actions) {
    const now = availability(kind, { offline: false, waiting: 'made' });
    expect(item(label).dataset['hint'], label).toBe(now.allowed ? undefined : now.hint);
  }
  // Waiting, it does nothing; one that runs offline still does.
  act(() => item('Share…').click());
  expect(ran).toEqual([]);
  act(() => item('New page here').click());
  expect(ran).toEqual(['new page']);
});

it('offers every action online for a folder the server has', async () => {
  const { ran, item } = await openMenu('none');
  expect(item('Rename…').hasAttribute('aria-disabled')).toBe(false);
  act(() => item('Rename…').click());
  expect(ran).toEqual(['rename']);
});
