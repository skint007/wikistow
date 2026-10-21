import { pageHtml } from '@wikistow/client/reader';
import { toHtml } from 'hast-util-to-html';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vite-plus/test';
import { markdownJobs } from '../src/page/markdown-jobs.ts';

/** A body as the reader renders it, before React: read as the worker does, then `pageHtml`. */
function render(body: string): string {
  const processor = unified().use(remarkRehype, { allowDangerousHtml: true }).use(pageHtml);
  return toHtml(processor.runSync(markdownJobs.body(body)));
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
