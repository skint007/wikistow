import type { z } from 'zod';

/** What must hold before a command can run. */
export type Requirement = 'unlocked-vault' | 'page-editor' | 'space-owner';

/**
 * A named user action: a stable ID, a typed input, what it needs, and what
 * it does. Buttons and menus run commands instead of doing the work
 * themselves, so a command palette or shortcut can later run the same ones.
 *
 * The same shape as the client's command type (`id`, `input`, `requires`,
 * `run`), kept here until both land so they can become one.
 */
export type Command<Input extends z.ZodType, Env extends CommandEnv> = {
  id: string;
  input: Input;
  requires: readonly Requirement[];
  run: (input: z.output<Input>, env: Env) => Promise<void>;
};

/** Where a command runs: what holds there, and whatever else its `run` uses. */
export type CommandEnv = { satisfies: (requirement: Requirement) => boolean };

class CommandUnavailable extends Error {
  constructor(id: string, missing: Requirement[]) {
    super(`${id} needs ${missing.join(' and ')}`);
    this.name = 'CommandUnavailable';
  }
}

/** Check the command's requirements and input, then run it. */
export async function runCommand<Input extends z.ZodType, Env extends CommandEnv>(
  command: Command<Input, Env>,
  input: z.input<Input>,
  env: Env,
): Promise<void> {
  const missing = command.requires.filter((requirement) => !env.satisfies(requirement));
  if (missing.length > 0) throw new CommandUnavailable(command.id, missing);
  await command.run(command.input.parse(input), env);
}
