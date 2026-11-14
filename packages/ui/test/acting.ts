import { act } from 'react';
import { expect } from 'vite-plus/test';

/**
 * `expect.poll` on what React shows, letting React work between tries.
 * Polled inside `act`, work React is pinged for meanwhile waits until `act`
 * ends: a visual editor that suspended until the syntaxes' editor nodes
 * load (`loadSyntaxNodes`) never mounts while it's polled for.
 */
export const pollActing = <T>(value: () => T, options?: Parameters<typeof expect.poll>[1]) =>
  expect.poll(async () => {
    await act(async () => {});
    return value();
  }, options);
