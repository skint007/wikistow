import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';
import { htmlMarkdown } from '../src/page/editor/visual/html-markdown.ts';
import { inertHost } from '../src/page/editor/visual/host.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import WORD from './word-paste.html?raw';

// HTML made Markdown with no editor open, as a clip is (ADR 0017 step 3),
// against the same HTML pasted into an empty page in the visual editor, in
// Chromium: the two must give the same Markdown.

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** What pasting `html`, with `text` as its plain text, into an empty visual editor writes. */
async function pasted(html: string, text: string): Promise<string> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const host = inertHost();
  await act(async () =>
    root.render(
      <StrictMode>
        <VisualSurface
          ref={ref}
          initial=""
          onChange={() => {}}
          links={host.links()}
          attachments={host.attachments()}
          onFiles={() => {}}
        />
      </StrictMode>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(() => expect.poll(() => container.querySelectorAll('.ProseMirror').length).toBe(1));
  const dom = container.querySelector<HTMLElement>('#page-visual');
  const handle = ref.current;
  if (!handle || !dom) throw new Error('The editor did not mount');
  dom.focus();
  const transfer = new DataTransfer();
  transfer.setData('text/html', html);
  transfer.setData('text/plain', text);
  dom.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
  // A paste goes in at once; reading waits for nothing.
  return handle.read();
}

/** Both ways of making `html` Markdown, which must agree; what they give. */
async function bothWays(html: string, text = '') {
  const clip = await htmlMarkdown(html, text);
  const paste = await pasted(html, text);
  expect(clip.markdown).toBe(paste);
  return clip;
}

describe('HTML to Markdown without an editor', () => {
  it('writes what a paste of the same HTML writes', async () => {
    const { markdown, faithful } = await bothWays(
      '<h2>Beans</h2><p>Sow <b>late</b>, in <i>rows</i>.</p><blockquote><p>Water well.</p></blockquote><pre><code>sow(beans)</code></pre><hr>',
    );
    expect(markdown).toBe(
      '## Beans\n\nSow **late**, in *rows*.\n\n> Water well.\n\n```\nsow(beans)\n```\n\n***\n',
    );
    expect(faithful).toBe(true);
  });

  it('leaves out what a browser hides', async () => {
    const { markdown } = await bothWays(
      [
        '<p>Shown</p>',
        '<p style="display: none">Hidden by display</p>',
        '<p hidden>Hidden by attribute</p>',
        '<p><span style="visibility: hidden">Invisible </span>kept</p>',
        '<div style="visibility: hidden"><p>Gone</p><p style="visibility: visible">Shown again</p></div>',
        '<p style="opacity: 0">Transparent</p>',
        '<noscript><p>Without scripts</p></noscript>',
        '<script>alert(1)</script><style>p { color: red }</style>',
        '<details><summary>Summary</summary><p>Closed details</p></details>',
        '<select><option>An option</option></select>',
        '<svg width="10" height="10"><title>A title</title><desc>A description</desc></svg>',
      ].join(''),
      'Shown',
    );
    expect(markdown).toBe('Shown\n\nkept\n\nShown again\n\nSummary\n');
  });

  it('keeps each image as the one a browser shows', async () => {
    const { markdown } = await bothWays(
      [
        '<p><img src="https://example.com/a.png" alt="Plain"></p>',
        '<p><img src="https://example.com/b-1x.png" srcset="https://example.com/b-1x.png 1x, https://example.com/b-9x.png 9x" alt="Dense"></p>',
        '<picture><source srcset="https://example.com/c.unknown" type="image/x-unknown"><source srcset="https://example.com/c.webp" type="image/webp"><img src="https://example.com/c.png" alt="Pictured"></picture>',
        '<p><img data-src="attachment:a1" alt="Claimed"></p>',
        '<p><img src="https://example.com/d.png" alt="Titled" title="A title"></p>',
      ].join(''),
    );
    expect(markdown).toBe(
      [
        '![Plain](https://example.com/a.png)',
        '',
        '![Dense](https://example.com/b-1x.png)',
        '',
        '![Pictured](https://example.com/c.webp)',
        '',
        '![Titled](https://example.com/d.png "A title")',
        '',
      ].join('\n'),
    );
  });

  it('makes Word’s list paragraphs lists', async () => {
    const { markdown, faithful } = await bothWays(WORD, 'Garden plan');
    expect(markdown).toBe(
      [
        '# Garden plan',
        '',
        '# Spring',
        '',
        'Sow the **tomatoes** early and the *beans* late.',
        '',
        '- Tomatoes',
        '  - Cherry',
        '- Beans',
        '',
        'Then:',
        '',
        '1. Water',
        '2. Mulch',
        '',
      ].join('\n'),
    );
    expect(faithful).toBe(true);
  });

  it('keeps links where they go, and reads addresses and wikilinks in text', async () => {
    const { markdown } = await bothWays(
      [
        '<p>See <a href="https://example.com/x" title="X">the site</a>, ',
        '<a href="https://example.com/shown">https://example.com/other</a>, ',
        'https://example.org/bare and [[Plan|the plan]].</p>',
        '<p><a href="#top">An anchor</a> and <a>no address</a>.</p>',
      ].join(''),
    );
    expect(markdown).toBe(
      [
        'See [the site](https://example.com/x "X"), [https://example.com/other](https://example.com/shown), https://example.org/bare and [[Plan|the plan]].',
        '',
        '[An anchor](#top) and no address.',
        '',
      ].join('\n'),
    );
  });

  it('keeps a footnote from elsewhere as its text', async () => {
    const { markdown } = await bothWays(
      [
        '<p>Beans<sup><a href="#fn-1" id="fnref-1" data-footnote-ref>1</a></sup> and [^2].</p>',
        '<section data-footnotes class="footnotes"><h2 id="footnote-label">Footnotes</h2><ol>',
        '<li id="fn-1"><p>Sow late. <a href="#fnref-1" data-footnote-backref>↩</a></p></li>',
        '</ol></section>',
      ].join(''),
    );
    expect(markdown).toBe(
      [
        'Beans[1](#fn-1) and \\[^2].',
        '',
        '## Footnotes',
        '',
        '1. Sow late. [↩](#fnref-1)',
        '',
      ].join('\n'),
    );
  });

  it('makes tables, with a header row and wikilinks in cells as cells hold them', async () => {
    const { markdown } = await bothWays(
      [
        '<table><thead><tr><th>Crop</th><th align="right">Rows</th></tr></thead>',
        '<tbody><tr><td>Beans</td><td align="right">2</td></tr>',
        '<tr><td>[[Plan|the plan]]</td><td>a | b</td></tr></tbody></table>',
        '<table><tr><td>No</td><td>header</td></tr></table>',
      ].join(''),
    );
    expect(markdown).toBe(
      [
        '| Crop               |   Rows |',
        '| ------------------ | -----: |',
        '| Beans              |      2 |',
        '| [[Plan\\|the plan]] | a \\| b |',
        '',
        // A table must start with a header row, so one without is given an empty one.
        '|    |        |',
        '| -- | ------ |',
        '| No | header |',
        '',
      ].join('\n'),
    );
  });

  it('gives the text of HTML that can’t be read', async () => {
    // The character styles are marked with, which makes `unstyled` refuse it.
    const { markdown } = await bothWays('<p>Odd﷐ <b>text</b></p>', 'Odd text\nOn two lines');
    expect(markdown).toBe('Odd text\n\nOn two lines\n');
  });

  it('gives nothing for HTML that shows nothing, with no text', async () => {
    const { markdown } = await bothWays('<p hidden>Gone</p>');
    expect(markdown).toBe('');
  });

  it('starts afresh for each', async () => {
    await htmlMarkdown('<p>First</p>');
    const { markdown } = await htmlMarkdown('<p>Second</p>');
    expect(markdown).toBe('Second\n');
  });
});
