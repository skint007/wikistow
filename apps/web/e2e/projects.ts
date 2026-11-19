// Which projects a `playwright test` command line runs, so the config can
// leave out a server no chosen project needs (#514). Playwright starts every
// `webServer` whatever `--project` says.

/**
 * Whether `playwright test`, run with `argv`, runs the project `name`: yes,
 * unless `--project` is given and names only other projects. Names match as
 * Playwright's own filter matches them: ignoring case, with `*` matching
 * anything. `--project` takes every value up to the next option, as
 * `--project chromium live`, and can be repeated or written `--project=live`.
 * In UI and watch mode every project can run.
 */
export function runsProject(
  argv: readonly string[],
  name: string,
  env: Record<string, string | undefined> = {},
): boolean {
  // UI and watch mode let you choose any project once they're open,
  // whatever `--project` ticked to start with.
  if (env['PWTEST_WATCH'] || argv.some((arg) => /^--ui(-host|-port)?(=|$)/.test(arg))) return true;
  const chosen = projectFilter(argv);
  return chosen === undefined || chosen.some((pattern) => matches(pattern, name));
}

/** The names `--project` gives in `argv`, or undefined when it isn't given. */
function projectFilter(argv: readonly string[]): string[] | undefined {
  let chosen: string[] | undefined;
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!;
    // Everything after `--` is a test file filter, not an option.
    if (arg === '--') break;
    if (arg.startsWith('--project=')) {
      (chosen ??= []).push(arg.slice('--project='.length));
    } else if (arg === '--project') {
      chosen ??= [];
      while (at + 1 < argv.length && !argv[at + 1]!.startsWith('-')) chosen.push(argv[++at]!);
    }
  }
  return chosen;
}

function matches(pattern: string, name: string): boolean {
  // Lowercased as Playwright lowercases both, so a locale's own rules agree.
  const parts = pattern
    .toLocaleLowerCase()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 'i').test(name.toLocaleLowerCase());
}
