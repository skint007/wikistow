import { publicLinkOperations } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { renderBody } from '../src/public-links/render.ts';

// A public copy writes the page's values into its body as text (ADR 0006,
// decision 9). Whatever a value holds, the server renders it as that text.

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '[x](javascript:alert(1))',
  '![x](https://tracker.example/x.png)',
  '<https://evil.example>',
  '*bold* _it_ ~~gone~~',
  'a | b',
  '`code`',
  '[[Secret page]]',
  '&lt;b&gt;',
  '[^1]',
  '# heading',
];

/** A page with each hostile value as a property, referred to in a paragraph and a table cell. */
function page(): string {
  const yaml = HOSTILE.map((value, i) => `v${i}: ${JSON.stringify(value)}`).join('\n');
  const references = HOSTILE.map((_, i) => `\`=v${i}\``);
  const table = HOSTILE.map((_, i) => `| \`=v${i}\` | after |`).join('\n');
  return `---\n${yaml}\n---\n${references.join(' · ')}\n\n| value | next |\n| - | - |\n${table}\n`;
}

/** The copy's HTML, as the server renders it for its public page. */
function rendered(markdown: string): string {
  const { segments } = renderBody({
    markdown,
    linkId: 'link',
    attachments: [],
    limits: { fileBytes: 1_000_000, copyBytes: 10_000_000 },
  });
  return segments.map((segment) => (typeof segment === 'string' ? segment : '')).join('');
}

/** `html`'s text, its tags out and its character references read, once. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|amp|lt|gt|quot);/gi, (_, name: string) =>
      name.startsWith('#')
        ? String.fromCodePoint(parseInt(name.slice(2), 16))
        : (({ amp: '&', lt: '<', gt: '>', quot: '"' } as Record<string, string>)[name] ?? ''),
    );

/** What the reader shows of each value: a page link alone as the text it shows. */
const shown = (value: string) => (value === '[[Secret page]]' ? 'Secret page' : value);

describe('values written into a public copy', () => {
  it('render as their text, in a paragraph and in table cells, making no HTML', () => {
    const html = rendered(publicLinkOperations.copyBody(page()));
    for (const tag of ['img', 'script', 'em', 'strong', 'del', 'code', 'h1', 'sup']) {
      expect(html, tag).not.toMatch(new RegExp(`<${tag}[\\s>]`));
    }
    // GFM links a web address in text, escaped or not: only such, as written.
    const hrefs = [...html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(([, href]) => href);
    expect(hrefs).toHaveLength(4);
    for (const href of hrefs)
      expect(href).toMatch(/^https:\/\/(evil\.example|tracker\.example\/x\.png)$/);
    expect(html).not.toMatch(/href="javascript/);
    expect(html).not.toMatch(/<[^>]* onerror=/);
    const [paragraph, ...cells] = html.split('<table>');
    expect(textOf(paragraph ?? '').trim()).toBe(HOSTILE.map(shown).join(' · '));
    const rows = (cells.join('').match(/<tr>[\s\S]*?<\/tr>/g) ?? []).slice(1);
    expect(rows.map((row) => (row.match(/<td>[\s\S]*?<\/td>/g) ?? []).map(textOf))).toEqual(
      HOSTILE.map((value) => [shown(value), 'after']),
    );
  });

  it('render as their text whatever the text around them opens', () => {
    const page = [
      '---\nb: b\nimg: img src\nfoo: foo\nlt: lt\nempty:\n---',
      'x <`=b`> y **z**',
      '',
      '<`=img`=x>',
      '',
      '[`=foo`] and &`=lt`;',
      '',
      'Para',
      '`=empty`',
      '---',
      '',
      '[foo]: https://evil.example/',
      '',
    ].join('\n');
    const html = rendered(publicLinkOperations.copyBody(page));
    for (const tag of ['b', 'img', 'hr'])
      expect(html, tag).not.toMatch(new RegExp(`<${tag}[\\s>]`));
    expect(html).not.toContain('evil.example');
    expect(textOf(html)).toContain('x <b> y z');
    expect(textOf(html)).toContain('[foo] and &lt;');
    // A heading, as the app shows it, an empty value a dash in it.
    expect(textOf(/<h2[^>]*>[\s\S]*?<\/h2>/.exec(html)?.[0] ?? '')).toBe('Para\n–');
  });

  it('leaves a reference to no property, and real code, as code', () => {
    const html = rendered(publicLinkOperations.copyBody('---\na: 1\n---\n`=b` and `x = 1`\n'));
    expect(html).toContain('<code>=b</code>');
    expect(html).toContain('<code>x = 1</code>');
  });
});
