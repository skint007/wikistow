import { describe, expect, it } from 'vite-plus/test';
import { run } from '../src/cli.ts';
import { EXIT } from '../src/exit.ts';
import { USAGE, VERSION } from '../src/help.ts';
import { SKILL } from '../src/skill.ts';
import { fakeIo, privateDir } from './support/fake-io.ts';

const PAGE = 'A'.repeat(22);
const REV = 'B'.repeat(22);

async function runIn(argv: string[]) {
  const { home } = await privateDir();
  const fake = fakeIo({ env: { HOME: home } });
  const status = await run(argv, fake.io);
  return { status, ...fake.written, asked: fake.asked };
}

describe('the command line', () => {
  it.each([
    [['frobnicate']],
    [['page', 'publish', PAGE, '--revision', REV]],
    [['page', 'publish-to', PAGE, '--space', PAGE, '--revision', REV]],
  ])('refuses %j as a usage error, before touching anything', async (argv) => {
    const result = await runIn([...argv, '--json']);
    expect(result.status).toBe(EXIT.usage);
    expect(JSON.parse(result.stdout).error).toMatchObject({ exit: 2 });
    expect(result.asked).toEqual([]);
  });

  it('takes IDs that start with - or --, as arguments and as option values', async () => {
    // Past parsing, these fail only because nothing is enrolled.
    for (const argv of [
      ['page', 'read', `-${PAGE.slice(1)}`, '--json'],
      ['page', 'read', `--${PAGE.slice(2)}`, '--json'],
      ['tree', '--space', '--x', '--json'],
    ]) {
      const result = await runIn(argv);
      expect(JSON.parse(result.stdout).error.code, argv.join(' ')).toBe('not-enrolled');
    }
  });
});

describe('skill', () => {
  it('prints the skill, enrolled or not, and in --json', async () => {
    const plain = await runIn(['skill']);
    expect(plain.status).toBe(EXIT.ok);
    expect(plain.stdout).toMatch(/^---\nname: wikistow\ndescription: Use when /);
    expect(plain.stdout).toContain(`wikistow-version: "${VERSION}"`);
    expect(plain.asked).toEqual([]);
    const json = await runIn(['skill', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ skill: plain.stdout });
  });

  it('names only commands and options this CLI has', async () => {
    const spans = [...SKILL.matchAll(/`([^`]+)`/g)].map(([, span = '']) => span);
    const commands = spans
      .map((span) => span.replace(/^wikistow /, ''))
      .filter((span) => /^(agent|page|spaces|tree|search|export)\b/.test(span))
      .map((span) => span.split(' ').filter((word) => !word.startsWith('-')));
    expect(commands.length).toBeGreaterThan(5);
    for (const words of commands) {
      const result = await runIn([...words, '--help']);
      expect(result.status, words.join(' ')).toBe(EXIT.ok);
    }
    for (const option of SKILL.match(/--[a-z][a-z-]*/g) ?? []) {
      if (option !== '--help') expect(USAGE, option).toMatch(new RegExp(`${option}\\b`));
    }
  });
});
