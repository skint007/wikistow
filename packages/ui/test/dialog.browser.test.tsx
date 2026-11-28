import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, expect, it } from 'vite-plus/test';
import { Dialog, DialogContent, DialogTitle } from '../src/components/ui/dialog.tsx';

// A dialog with many steps, such as Replace my keys (#771), closes only with
// its close button: not Escape, and not a click outside it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
afterEach(() => unmount());

function OnlyItsButton() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closesOnBackdrop={false} closesOnEscape={false}>
        <DialogTitle>Steps</DialogTitle>
        <input aria-label="Typed" />
      </DialogContent>
    </Dialog>
  );
}

it('closes only with its close button', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<OnlyItsButton />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);

  // Escape, twice: a browser may close it past a refused first one.
  await act(() => userEvent.click(document.querySelector('input')!));
  await act(() => userEvent.keyboard('{Escape}'));
  await act(() => userEvent.keyboard('{Escape}'));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('input')).not.toBeNull();

  // A click on the backdrop lands on the <dialog> itself.
  await act(() => userEvent.click(dialog, { position: { x: 1, y: 1 } }));
  expect(dialog.open).toBe(true);

  await act(() => userEvent.click(document.querySelector('button')!));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(dialog.open).toBe(false);
});
