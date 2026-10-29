import { describe, expect, it } from 'vite-plus/test';
import {
  bodyStart,
  setPageProperty,
  setTask,
  taskAt,
  taskItems,
  type TaskItem,
} from '../src/index.ts';

/** The task whose line is `line`, as `taskItems` finds it. */
function find(markdown: string, line: string): TaskItem {
  const task = taskItems(markdown).find((item) => item.line === line);
  if (!task) throw new Error(`No task “${line}” in the Markdown`);
  return task;
}

/** `markdown` with the task `line` ticked or not, found where it starts in `markdown`. */
function tick(markdown: string, line: string, checked: boolean): string {
  const edit = setTask(markdown, { offset: find(markdown, line).offset, line, checked });
  if (!edit.ok) throw new Error(edit.reason);
  return edit.markdown;
}

describe('task items', () => {
  it('are found in every kind of list, frontmatter counted in their offsets', () => {
    const markdown = [
      '---',
      'title: Shopping',
      '---',
      '- [ ] milk',
      '- [x] bread',
      '  - [X] crumbs',
      '',
      '1. [ ] first',
      '2) [x] second',
      '',
      '> - [ ] quoted',
      '',
      '* plain',
      '+ [ ] spaced  ',
      '',
      '```',
      '- [ ] in code',
      '```',
    ].join('\n');
    const items = taskItems(markdown);
    expect(items.map(({ line, checked }) => [line, checked])).toEqual([
      ['milk', false],
      ['bread', true],
      ['crumbs', true],
      ['first', false],
      ['second', true],
      ['quoted', false],
      ['spaced', false],
    ]);
    for (const item of items) {
      expect(taskAt(markdown, item.offset)).toEqual(item);
      expect(markdown[item.mark]).toMatch(/^[ xX]$/);
    }
    // Where each list item starts: its marker, after any indentation or `>`.
    expect(markdown.slice(find(markdown, 'milk').offset)).toMatch(/^- \[ \] milk/);
    expect(markdown.slice(find(markdown, 'crumbs').offset)).toMatch(/^- \[X\] crumbs/);
    expect(markdown.slice(find(markdown, 'quoted').offset)).toMatch(/^- \[ \] quoted/);
  });

  it('are found after a byte order mark, which the parser doesn’t count', () => {
    const markdown = '\uFEFF- [ ] milk\n- [x] bread\n';
    expect(bodyStart(markdown)).toBe(1);
    expect(taskItems(markdown).map(({ offset, line }) => [offset, line])).toEqual([
      [1, 'milk'],
      [12, 'bread'],
    ]);
    expect(tick(markdown, 'milk', true)).toBe('\uFEFF- [x] milk\n- [x] bread\n');
    expect(bodyStart('---\na: 1\n---\nBody\n')).toBe(13);
  });

  it('aren’t found where no task starts', () => {
    const markdown = '- plain\n- [ ] task\n\n[ ] not a list\n';
    expect(taskAt(markdown, 0)).toBeNull();
    expect(taskAt(markdown, markdown.indexOf('[ ] not'))).toBeNull();
    expect(taskAt(markdown, -1)).toBeNull();
    expect(taskAt(markdown, 1.5)).toBeNull();
    expect(taskAt(markdown, markdown.length)).toBeNull();
    // A box needs a blank or the line's end after it.
    expect(taskAt('- [x]done', 0)).toBeNull();
    // GitHub's rule: a box alone on its line isn't a task.
    expect(taskItems('- [ ]\n')).toEqual([]);
  });
});

describe('ticking a task', () => {
  it('changes only the character between its brackets, and unticks `[X]` too', () => {
    const markdown = '- [ ] milk\n- [X] bread\n';
    expect(tick(markdown, 'milk', true)).toBe('- [x] milk\n- [X] bread\n');
    expect(tick(markdown, 'bread', false)).toBe('- [ ] milk\n- [ ] bread\n');
  });

  it('leaves a task already as asked as it is, so a change made twice changes nothing more', () => {
    const markdown = '- [X] bread\n';
    expect(tick(markdown, 'bread', true)).toBe(markdown);
    expect(tick(tick(markdown, 'bread', false), 'bread', false)).toBe('- [ ] bread\n');
  });

  it('keeps CRLF line breaks, nested, ordered and quoted lists as written', () => {
    const markdown =
      '---\r\ntags: [a]\r\n---\r\n1. [ ] one\r\n   - [ ] nested\r\n> 2) [x] quoted\r\n';
    expect(tick(markdown, 'nested', true)).toBe(
      '---\r\ntags: [a]\r\n---\r\n1. [ ] one\r\n   - [x] nested\r\n> 2) [x] quoted\r\n',
    );
    expect(tick(markdown, 'quoted', false)).toBe(
      '---\r\ntags: [a]\r\n---\r\n1. [ ] one\r\n   - [ ] nested\r\n> 2) [ ] quoted\r\n',
    );
    expect(tick(markdown, 'one', true)).toContain('1. [x] one\r\n');
  });

  it('finds the task by its line in newer text, where lines above it came or went', () => {
    const ticked = '- [ ] milk\n- [ ] bread\n';
    const change = { offset: find(ticked, 'bread').offset, line: 'bread', checked: true };
    // A line added above: the offset now lands on another task.
    expect(setTask(`- [ ] eggs\n${ticked}`, change)).toEqual({
      ok: true,
      markdown: '- [ ] eggs\n- [ ] milk\n- [x] bread\n',
    });
    // Frontmatter added above it.
    expect(setTask(`---\nservings: 4\n---\n${ticked}`, change)).toEqual({
      ok: true,
      markdown: '---\nservings: 4\n---\n- [ ] milk\n- [x] bread\n',
    });
  });

  it('is refused when the task is gone, or its line is on more than one task', () => {
    const change = { offset: 11, line: 'bread', checked: true };
    expect(setTask('- [ ] milk\n- [ ] toast\n', change)).toEqual({
      ok: false,
      reason: 'The task “bread” isn’t on the page any more.',
    });
    expect(setTask('- [ ] bread\n- [ ] milk\n\n- [x] bread\n', change)).toEqual({
      ok: false,
      reason: 'The task “bread” is on the page more than once now.',
    });
    // In code it isn't a task.
    expect(setTask('```\n- [ ] milk\n- [ ] bread\n```\n', change).ok).toBe(false);
  });
});

describe('a property set in a page’s whole Markdown', () => {
  it('changes only its value, the body as it was', () => {
    expect(setPageProperty('---\nservings: 4 # people\n---\nBody\n', 'servings', 6)).toEqual({
      ok: true,
      markdown: '---\nservings: 6 # people\n---\nBody\n',
    });
  });

  it('gives a page with no block one, in its line breaks', () => {
    expect(setPageProperty('Body\r\nMore\r\n', 'servings', 2)).toEqual({
      ok: true,
      markdown: '---\r\nservings: 2\r\n---\r\nBody\r\nMore\r\n',
    });
  });

  it('is the same text when the value is the one it has, and refused when it can’t be set in place', () => {
    const markdown = '---\nservings: 4\nnotes: |\n  Fresh.\n---\n';
    expect(setPageProperty(markdown, 'servings', 4)).toEqual({ ok: true, markdown });
    expect(setPageProperty(markdown, 'notes', 'Stale.').ok).toBe(false);
  });
});
