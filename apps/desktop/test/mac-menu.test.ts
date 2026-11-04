import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vite-plus/test';
import { macMenu, type MenuAction } from '../src/mac-menu.ts';

// CI starts the Mac app but opens no menu in it, so this is what checks the Edit menu.
describe('the Mac menu', () => {
  const edit = (acted: MenuAction[]) => {
    const menu = macMenu((action) => acted.push(action)).find((m) => m.label === 'Edit');
    return (menu?.submenu ?? []) as MenuItemConstructorOptions[];
  };

  it('keeps the editing roles Cmd+C, V, X, Z and A need in text fields', () => {
    const roles = edit([]).map((item) => item.role);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
      expect(roles).toContain(role);
  });

  it('has Find…, with Cmd+F, which asks the page to open Find on page', () => {
    const acted: MenuAction[] = [];
    const find = edit(acted).find((item) => item.label === 'Find…');
    expect(find?.accelerator).toBe('Cmd+F');
    const click = find?.click as (() => void) | undefined;
    click?.();
    expect(acted).toEqual(['find']);
  });
});
