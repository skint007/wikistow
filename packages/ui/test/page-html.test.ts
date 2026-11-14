import { taskItems } from '@wikistow/client';
import { pageHtml, sanitizedPage, taskLabels, taskMarks } from '@wikistow/client/reader';
import { toHtml } from 'hast-util-to-html';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vite-plus/test';
import { markdownJobs } from '../src/page/markdown-jobs.ts';

/**
 * A body as the reader renders it, before React: read as the worker does,
 * its tasks marked as starting `start` into the page, then `pageHtml`.
 */
function render(body: string, start = 0): string {
  const tree = markdownJobs.body(body);
  const processor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(taskMarks, start, taskLabels(tree))
    .use(pageHtml);
  return toHtml(processor.runSync(tree));
}

describe('a page’s HTML', () => {
  it('renders as HTML, Markdown in it too, with nothing that runs or loads', () => {
    const html = render(
      [
        '<details>',
        '<summary>More</summary>',
        '',
        '- **item**',
        '',
        '</details>',
        '',
        'Press <kbd>Ctrl</kbd> + <kbd>K</kbd>.',
        '',
        '<div id="top" name="n" style="color: red" onclick="run()">Box</div>',
        '',
        '<img src="https://example.com/x.png" onerror="run()" alt="x">',
        '<a href="javascript:run()">bad</a> <a href="attachment:a1">file</a>',
        '',
        '<picture><source srcset="https://example.com/y.png"><img src="attachment:i1"></picture>',
        '',
        '<script>run()</script>',
        '',
        '<iframe src="https://example.com"></iframe><form><button>Go</button></form>',
      ].join('\n'),
    );
    expect(html).toContain(
      '<details>\n<summary>More</summary>\n<ul>\n<li><strong>item</strong></li>',
    );
    expect(html).toContain('Press <kbd>Ctrl</kbd> + <kbd>K</kbd>.');
    expect(html).toContain('<div id="top" name="user-content-n">Box</div>');
    expect(html).toContain('<img src="https://example.com/x.png" alt="x">');
    expect(html).toContain('<a>bad</a> <a href="attachment:a1">file</a>');
    expect(html).toContain('<img src="attachment:i1">');
    // GitHub's tag filter: shown as text, never run.
    expect(html).toContain('&#x3C;script>run()&#x3C;/script>');
    expect(html).toContain('&#x3C;iframe src="https://example.com">&#x3C;/iframe>Go');
    expect(html).not.toMatch(
      /<(script|iframe|form|button|picture|source)\b|style=|onclick|onerror/,
    );
  });
});

describe('a page’s highlights and colours', () => {
  const PAGE = [
    'A ==highlight==, <span data-color="red">red **text**</span> and <mark data-color="blue">a blue highlight</mark>.',
    '',
    '<span data-color="pink">no colour</span> <span data-color="red" style="color: #f00" onclick="run()">red</span> <mark data-color="url(x)" style="background: red">plain</mark> <span data-color=" red">x</span>',
    '',
    '<div data-color="red">box</div> <b data-color="red">bold</b>',
  ].join('\n');

  it('render as `<mark>` and the theme’s colours, and only those, in the app', () => {
    const html = render(PAGE);
    expect(html).toContain(
      'A <mark>highlight</mark>, <span data-color="red">red <strong>text</strong></span> and <mark data-color="blue">a blue highlight</mark>.',
    );
    // HTML the reader doesn't read as colour keeps a colour from the list, on a span or a mark, and nothing else.
    expect(html).toContain(
      '<span>no colour</span> <span data-color="red">red</span> <mark>plain</mark> <span>x</span>',
    );
    expect(html).toContain('<div>box</div> <b>bold</b>');
    expect(html).not.toMatch(/style=|onclick/);
    // A page with no other HTML isn't parsed again, and keeps them too.
    expect(render('==a== <span data-color="green">b</span>\n')).toBe(
      '<p><mark>a</mark> <span data-color="green">b</span></p>',
    );
  });

  it('render the same on a public page, which is always sanitized', () => {
    const processor = unified().use(remarkRehype, { allowDangerousHtml: true });
    const tree = processor.runSync(markdownJobs.body(PAGE));
    const html = toHtml(sanitizedPage(tree));
    expect(html).toContain(
      'A <mark>highlight</mark>, <span data-color="red">red <strong>text</strong></span> and <mark data-color="blue">a blue highlight</mark>.',
    );
    expect(html).toContain(
      '<span>no colour</span> <span data-color="red">red</span> <mark>plain</mark>',
    );
    expect(html).not.toMatch(/style=|onclick|<div data-color/);
  });
});

describe('a page’s tasks', () => {
  it('mark each checkbox with where its item starts in the whole page, and label it', () => {
    const frontmatter = '---\ntitle: List\n---\n';
    const body = '- [ ] milk *now*\n  - [x] nested\n\n1. [X] loose\n\n   more\n';
    // With raw HTML in the page too, which is parsed and sanitized after.
    for (const html of ['', '\n<b>bold</b>\n']) {
      const out = render(body + html, frontmatter.length);
      const offsets = taskItems(frontmatter + body).map(({ offset }) => offset);
      expect(offsets).toHaveLength(3);
      expect(out).toContain(
        `<input type="checkbox" disabled data-task="${offsets[0]}" aria-label="milk now">`,
      );
      expect(out).toContain(
        `<input type="checkbox" checked disabled data-task="${offsets[1]}" aria-label="nested">`,
      );
      expect(out).toContain(`data-task="${offsets[2]}" aria-label="loose">`);
    }
  });

  it('are labelled by their links’ text and their references as written', () => {
    const out = render(
      '- [ ] [[Dentist]]\n- [ ] [[Car service|the car]]\n- [ ] Call [[Mum]] about `=servings` <b>now</b>\n',
    );
    expect(out).toContain('aria-label="Dentist"');
    expect(out).toContain('aria-label="the car"');
    expect(out).toContain('aria-label="Call Mum about =servings now"');
  });

  it('leave a checkbox the page’s HTML holds unmarked, and a public page’s too', () => {
    const out = render('<ul><li class="task-list-item"><input type="checkbox"> mine</li></ul>\n');
    expect(out).toContain('<input type="checkbox" disabled>');
    expect(out).not.toContain('data-task');
    const processor = unified().use(remarkRehype, { allowDangerousHtml: true });
    const tree = processor.runSync(markdownJobs.body('- [ ] milk\n'));
    expect(toHtml(sanitizedPage(tree))).toContain('<input type="checkbox" disabled> milk');
  });
});
