import type { Input } from 'electron';
import { describe, expect, it } from 'vite-plus/test';
import { shortcut } from '../src/shortcuts.ts';

const key = (key: string, code: string, held: Partial<Input> = {}): Input => ({
  type: 'keyDown',
  key,
  code,
  isAutoRepeat: false,
  isComposing: false,
  shift: false,
  control: false,
  alt: false,
  meta: false,
  location: 0,
  modifiers: [],
  ...held,
});

// CI starts the Mac app but presses no keys in it, so this is what checks them.
describe('shortcuts on a Mac', () => {
  it.each([
    [key('r', 'KeyR', { meta: true }), 'reload'],
    [key('R', 'KeyR', { meta: true, shift: true }), 'reload'],
    [key('=', 'Equal', { meta: true }), 'zoom-in'],
    [key('+', 'Equal', { meta: true, shift: true }), 'zoom-in'],
    [key('-', 'Minus', { meta: true }), 'zoom-out'],
    [key('0', 'Digit0', { meta: true }), 'zoom-reset'],
    [key('f', 'KeyF', { meta: true, control: true }), 'toggle-full-screen'],
    // Alt makes I type `ˆ`.
    [key('ˆ', 'KeyI', { meta: true, alt: true }), 'toggle-developer-tools'],
    [key('w', 'KeyW', { meta: true }), 'close'],
    [key('q', 'KeyQ', { meta: true }), 'quit'],
  ] as const)('answers %#', (input, action) => {
    expect(shortcut(input, 'darwin')).toBe(action);
  });

  it('leaves editing keys to the Edit menu, and Ctrl to the page', () => {
    expect(shortcut(key('c', 'KeyC', { meta: true }), 'darwin')).toBeNull();
    expect(shortcut(key('r', 'KeyR', { control: true }), 'darwin')).toBeNull();
    expect(shortcut(key('F5', 'F5'), 'darwin')).toBeNull();
  });

  it('keeps Ctrl, not Cmd, elsewhere', () => {
    expect(shortcut(key('r', 'KeyR', { control: true }), 'linux')).toBe('reload');
    expect(shortcut(key('r', 'KeyR', { meta: true }), 'linux')).toBeNull();
  });
});
