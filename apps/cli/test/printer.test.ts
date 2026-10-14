import { describe, expect, it } from 'vite-plus/test';
import { Printer } from '../src/io.ts';
import { fakeIo } from './support/fake-io.ts';

const ESC = String.fromCodePoint(0x1b);

describe('what the CLI prints', () => {
  it('writes decrypted content raw only when standard output isn’t a terminal', () => {
    const piped = fakeIo({ isTTY: false });
    new Printer(piped.io, { json: false }).raw(`# T${ESC}[31m`);
    expect(piped.written.stdout).toBe(`# T${ESC}[31m`);
    const tty = fakeIo({ isTTY: true });
    new Printer(tty.io, { json: false }).raw(`# T${ESC}[31m`);
    expect(tty.written.stdout).toBe('# T\\u{1b}[31m');
  });
});
