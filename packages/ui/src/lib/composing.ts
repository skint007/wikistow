import type { KeyboardEvent } from 'react';

/**
 * Whether a key ends an IME's composition, and so is the IME's: Safari
 * sends the Enter that does with `isComposing` false, and key code 229.
 */
export const composing = (event: KeyboardEvent<HTMLElement>) =>
  event.nativeEvent.isComposing || event.keyCode === 229;
