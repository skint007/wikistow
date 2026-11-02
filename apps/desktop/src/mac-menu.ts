// The menu bar on a Mac, where an app is expected to have one, and where
// Cmd+C, V, X, Z and A only work in text fields through an Edit menu with
// those roles. Linux and Windows have none: the titlebar's Window menu does
// what View does here. Main answers the View and Window keys before the
// page (shortcuts.ts); the menu shows them, and does them when clicked.
import type { WindowAction } from '@wikistow/contracts';
import type { MenuItemConstructorOptions } from 'electron';

/** The WikiStow, Edit, View and Window menus, each item doing `act` with its action. */
export function macMenu(
  act: (action: WindowAction | 'quit') => void,
): MenuItemConstructorOptions[] {
  const item = (label: string, action: WindowAction | 'quit', accelerator: string) => ({
    label,
    accelerator,
    click: () => act(action),
  });
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // Through main's own quit, which closes the window first.
        item('Quit WikiStow', 'quit', 'Cmd+Q'),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('Reload', 'reload', 'Cmd+R'),
        { type: 'separator' },
        item('Zoom In', 'zoom-in', 'Cmd+='),
        item('Zoom Out', 'zoom-out', 'Cmd+-'),
        item('Actual Size', 'zoom-reset', 'Cmd+0'),
        { type: 'separator' },
        item('Toggle Full Screen', 'toggle-full-screen', 'Ctrl+Cmd+F'),
        { type: 'separator' },
        item('Developer Tools', 'toggle-developer-tools', 'Alt+Cmd+I'),
      ],
    },
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        item('Close Window', 'close', 'Cmd+W'),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}
