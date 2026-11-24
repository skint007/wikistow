import { describe, expect, it } from 'vite-plus/test';
import {
  bodyStart,
  marksIgnored,
  setPageProperty,
  setTask,
  taskAt,
  taskItems,
  taskIndex,
  tasksWithLine,
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
    // Nor a box in code that now starts where the task did, its line the same (#700).
    const fenced = '```\nxxxxxx\n- [ ] bread\n```\n';
    expect(fenced.indexOf('- [ ] bread')).toBe(change.offset);
    expect(setTask(fenced, change)).toEqual({
      ok: false,
      reason: 'The task “bread” isn’t on the page any more.',
    });
  });

  describe('a line more than one task has, ticked in text that has changed since (#703)', () => {
    const PAGE = '## Mum\n- [ ] Call\n- [ ] Tidy\n\n## Bob\n- [ ] Call\n';
    // Bob's section and Mum's swapped: Bob's `Call` now starts where Mum's did.
    const SWAPPED = '## Bob\n- [ ] Call\n\n## Mum\n- [ ] Call\n- [ ] Tidy\n';
    /** The tick of the task `line` at `offset`, made in `markdown`. */
    const made = (markdown: string, line: string, offset: number) => ({
      offset,
      line,
      checked: true,
      madeIn: { markdown, repeated: tasksWithLine(markdown, line) > 1 },
    });
    const mums = made(PAGE, 'Call', PAGE.indexOf('- [ ] Call'));
    const bobs = made(PAGE, 'Call', PAGE.lastIndexOf('- [ ] Call'));
    const refused = {
      ok: false,
      reason:
        'The task “Call” is on the page more than once, and the page changed since it was ticked.',
    };

    it('is refused where the offset may now be another task with that line', () => {
      expect(SWAPPED.indexOf('- [ ] Call')).toBe(mums.offset);
      expect(setTask(SWAPPED, mums)).toEqual(refused);
    });

    it('is refused where the sections swapped differ only in what is ticked', () => {
      const page = '## A\n- [x] Notes\n- [ ] Call\n\n## A\n- [ ] Notes\n- [ ] Call\n';
      const swapped = '## A\n- [ ] Notes\n- [ ] Call\n\n## A\n- [x] Notes\n- [ ] Call\n';
      expect(setTask(swapped, made(page, 'Call', page.indexOf('- [ ] Call')))).toEqual(refused);
    });

    it('is refused where it was on more than one task as ticked, though one is left now', () => {
      // Swapped, and Mum's renamed: Bob's, the only `Call`, starts where hers did.
      const renamed = SWAPPED.replace('## Mum\n- [ ] Call', '## Mum\n- [ ] Text');
      expect(renamed.indexOf('- [ ] Call')).toBe(mums.offset);
      const once = {
        ok: false,
        reason:
          'The task “Call” was on the page more than once when it was ticked, and the page has changed since.',
      };
      expect(setTask(renamed, mums)).toEqual(once);
      // Mum's gone: Bob's is the only one, elsewhere.
      expect(setTask('## Bob\n\n- [ ] Call\n', mums)).toEqual(once);
    });

    it('is ticked by its offset in the text it was ticked in', () => {
      expect(setTask(PAGE, bobs)).toEqual({
        ok: true,
        markdown: '## Mum\n- [ ] Call\n- [ ] Tidy\n\n## Bob\n- [x] Call\n',
      });
      // After the person's own ticks before it, which its text holds.
      const mine = setTask(PAGE, mums);
      if (!mine.ok) throw new Error(mine.reason);
      expect(setTask(mine.markdown, made(mine.markdown, 'Call', bobs.offset))).toEqual({
        ok: true,
        markdown: '## Mum\n- [x] Call\n- [ ] Tidy\n\n## Bob\n- [x] Call\n',
      });
    });

    it('is ticked by its offset, or found by its line, where no task shares it', () => {
      const tidy = made(PAGE, 'Tidy', PAGE.indexOf('- [ ] Tidy'));
      expect(tidy.madeIn.repeated).toBe(false);
      // A word changed elsewhere, the same length: the offset still holds.
      const edited = PAGE.replace('## Bob', '## Bub');
      expect(setTask(edited, tidy)).toEqual({
        ok: true,
        markdown: edited.replace('- [ ] Tidy', '- [x] Tidy'),
      });
      expect(setTask(SWAPPED, tidy)).toEqual({
        ok: true,
        markdown: SWAPPED.replace('- [ ] Tidy', '- [x] Tidy'),
      });
      // Shared only now, by a task added since: the offset can't tell them apart.
      const added = `${PAGE}- [ ] Tidy\n`;
      expect(setTask(added, tidy).ok).toBe(false);
    });
  });

  it('takes the task items found before ticking for the text after, the page parsed once', () => {
    const before = Array.from({ length: 30 }, (_, i) => `- [ ] item ${i}\n`).join('');
    // A heading added above since they were made: each is found by its line, in the same items.
    const markdown = `# List\n\n${before}`;
    const items = taskIndex(markdown);
    // Kept: the same text asked again isn't parsed again.
    expect(taskIndex(markdown)).toBe(items);
    let ticked = markdown;
    for (let i = 0; i < 30; i++) {
      const line = `item ${i}`;
      const change = { offset: find(before, line).offset, line, checked: i % 2 === 0 };
      const made = setTask(ticked, change, () => items);
      if (!made.ok) throw new Error(made.reason);
      ticked = made.markdown;
    }
    expect(ticked).toBe(
      `# List\n\n${Array.from({ length: 30 }, (_, i) => `- [${i % 2 === 0 ? 'x' : ' '}] item ${i}\n`).join('')}`,
    );
    // Its box as this text has it, ticked since the items were found: unticked again.
    const made = setTask(
      ticked,
      { offset: find(ticked, 'item 0').offset, line: 'item 0', checked: false },
      () => items,
    );
    expect(made).toEqual({ ok: true, markdown: ticked.replace('- [x] item 0', '- [ ] item 0') });
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

describe('text compared with what is ticked aside', () => {
  it('empties every task’s box, nested ones too, and nothing that only looks like one', () => {
    expect(marksIgnored('- - [x] milk\n- - [ ] milk\n')).toBe('- - [ ] milk\n- - [ ] milk\n');
    expect(marksIgnored('> - [X] tea\n')).toBe('> - [ ] tea\n');
    const code = '```\n- [x] example\n```\n';
    expect(marksIgnored(code)).toBe(code);
  });
});
