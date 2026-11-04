// The name this CLI runs as. The AUR's `wikistow-cli-beta-bin` installs it
// beside `wikistow-cli-bin` as `wikistow-beta`, a CLI of its own: it keeps
// its files in their own directory, so it enrolls as a separate agent, and
// its help, skill and messages name the command an agent should run. Every
// other copy is `wikistow`, whatever version it is.
import { basename } from 'node:path';

export type Program = 'wikistow' | 'wikistow-beta';

/** The program a binary at `execPath` is: the beta only when its file is named so. */
export function programOf(execPath: string): Program {
  const name = basename(execPath)
    .toLowerCase()
    .replace(/\.exe$/, '');
  return name === 'wikistow-beta' ? 'wikistow-beta' : 'wikistow';
}

export const PROGRAM: Program = programOf(process.execPath);
