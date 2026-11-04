import { describe, expect, it } from 'vite-plus/test';
import { programOf } from '../src/program.ts';

describe('programOf', () => {
  it('is the beta only for a binary named wikistow-beta', () => {
    expect(programOf('/usr/bin/wikistow-beta')).toBe('wikistow-beta');
    expect(programOf('C:\\Users\\me\\wikistow-beta.exe'.replaceAll('\\', '/'))).toBe(
      'wikistow-beta',
    );
    expect(programOf('/usr/bin/wikistow')).toBe('wikistow');
    expect(programOf('/usr/bin/node')).toBe('wikistow');
    expect(programOf('/usr/bin/wikistow-beta-old')).toBe('wikistow');
  });
});
