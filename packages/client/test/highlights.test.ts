import type { Nodes, Root } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { describe, expect, it } from 'vite-plus/test';
import {
  highlightToMarkdown,
  mathToMarkdownExtension,
  parseMarkdown,
  wikilinkToMarkdown,
} from '../src/markdown/index.ts';

// Highlights (`==text==`) and the theme's colours in HTML (#403).

/** A node as `shape` shows it: its type, its colour if any, and its text or children. */
type Shape = string | [string, ...Shape[]];

const shape = (node: Nodes): Shape => {
  if (node.type === 'text') return node.value;
  if (node.type === 'html') return ['html', node.value];
  if (node.type === 'inlineCode') return ['inlineCode', node.value];
  const name = 'color' in node ? `${node.type}:${String(node.color)}` : node.type;
  return 'children' in node ? [name, ...node.children.map(shape)] : [name];
};

/** What the first block of `body` holds, by `shape`. */
const inline = (body: string): Shape[] => {
  const [block] = parseMarkdown(body).children;
  return block && 'children' in block ? block.children.map(shape) : [];
};

const stringify = (tree: Root) =>
  toMarkdown(tree, {
    bullet: '-',
    extensions: [gfmToMarkdown(), wikilinkToMarkdown, mathToMarkdownExtension, highlightToMarkdown],
  });

// What the page says, with where each node sat left out.
const meaning = (body: string): unknown =>
  JSON.parse(
    JSON.stringify(parseMarkdown(body), (key, value) => (key === 'position' ? undefined : value)),
  );

describe('highlights', () => {
  it('read `==text==` as a highlight, with marks in it and around it', () => {
    expect(inline('a ==b== c')).toEqual(['a ', ['highlight', 'b'], ' c']);
    expect(inline('==**b** c==')).toEqual([['highlight', ['strong', 'b'], ' c']]);
    expect(inline('**==b==**')).toEqual([['strong', ['highlight', 'b']]]);
    expect(inline('~~==b==~~')).toEqual([['delete', ['highlight', 'b']]]);
    expect(inline('*==b==*')).toEqual([['emphasis', ['highlight', 'b']]]);
    expect(inline('[==b==](https://x.test)')).toEqual([['link', ['highlight', 'b']]]);
    // Inside a word, as Obsidian reads it, and starting a line.
    expect(inline('x==y==z')).toEqual(['x', ['highlight', 'y'], 'z']);
    expect(inline('==marked== starts a line')).toEqual([['highlight', 'marked'], ' starts a line']);
    // Across the lines of a paragraph, not past it.
    expect(inline('==a\nb==')).toEqual([['highlight', 'a\nb']]);
    expect(inline('==a\n\nb==')).toEqual(['==a']);
  });

  it('leave text that only looks like one as text', () => {
    for (const body of [
      'a == b == c',
      '==a',
      'a==',
      '== a ==',
      '==a ==',
      '===a===',
      '==a===',
      '====',
      '\\==a==',
      '==a\\==',
      'x = y',
    ])
      expect(inline(body), body).toEqual([body.replace(/\\=/g, '=')]);
    expect(inline('`==a==`')).toEqual([['inlineCode', '==a==']]);
    expect(inline('[a](https://x.test/==b==)')).toEqual([['link', 'a']]);
    // A setext heading's underline is still one.
    expect(parseMarkdown('Title\n==\n').children[0]?.type).toBe('heading');
  });

  it('write back as written, and text that would read as one escaped', () => {
    for (const body of [
      'a ==b== c\n',
      '==**b** c==\n',
      '**==b==**\n',
      'x==y==z\n',
      '==marked== starts a line\n',
      '- ==item==\n',
      '| a     |\n| ----- |\n| ==b== |\n',
    ])
      expect(stringify(parseMarkdown(body)), body).toBe(body);
    // Text with `==` in it, written so it reads as text again.
    const text: Root = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '==a== b==c x == y' }] }],
    };
    const written = stringify(text);
    expect(inline(written)).toEqual(['==a== b==c x == y']);
    expect(written).toContain('x == y');
    // Beside a highlight, an `=` of the text's own.
    const beside: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'a=' },
            { type: 'highlight', children: [{ type: 'text', value: 'b' }] },
            { type: 'text', value: '=c' },
          ],
        },
      ],
    };
    expect(inline(stringify(beside))).toEqual(['a=', ['highlight', 'b'], '=c']);
  });

  it('read back as they were written, on any text of these characters', () => {
    // A small seeded generator, so a failure names its text.
    let seed = 403;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // Marks beside `=`, escapes of it, and line breaks, which a run of `=` alone ends a heading at.
    for (const parts of [
      ['=', '==', 'a', ' ', '*', '~~', '\\=', 'b', '_', '`'],
      ['=', '==', 'a', ' ', '\n', '\\='],
    ])
      for (let n = 0; n < 2000; n++) {
        let body = '';
        const length = 1 + Math.floor(random() * 12);
        for (let i = 0; i < length; i++) body += parts[Math.floor(random() * parts.length)];
        const written = stringify(parseMarkdown(body));
        expect(meaning(written), JSON.stringify(body)).toEqual(meaning(body));
      }
  });
});

describe('colours', () => {
  it('read a theme colour’s HTML around text as that colour', () => {
    expect(inline('<span data-color="red">a **b**</span> c')).toEqual([
      ['textColor:red', 'a ', ['strong', 'b']],
      ' c',
    ]);
    expect(inline('<mark data-color="blue">x</mark>')).toEqual([['colorHighlight:blue', 'x']]);
    expect(inline('==<span data-color="green">a</span>==')).toEqual([
      ['highlight', ['textColor:green', 'a']],
    ]);
    // Nested, with other HTML of their kind in them.
    expect(
      inline('<span data-color="red">a <span data-color="blue">b</span> <span>c</span></span>'),
    ).toEqual([
      [
        'textColor:red',
        'a ',
        ['textColor:blue', 'b'],
        ' ',
        ['html', '<span>'],
        'c',
        ['html', '</span>'],
      ],
    ]);
  });

  it('leave other HTML as HTML', () => {
    for (const body of [
      '<span data-color="pink">x</span>',
      '<span data-color="red" class="x">x</span>',
      "<span data-color='red'>x</span>",
      '<span style="color: red">x</span>',
      '<span data-color="red">x',
      '<span data-color="red">x</mark>',
    ])
      expect(
        inline(body).some((part) => Array.isArray(part) && part[0] !== 'html'),
        body,
      ).toBe(false);
    // Closed in another run of text, as across bold.
    expect(inline('<span data-color="red">a **b</span> c**')[0]).toEqual([
      'html',
      '<span data-color="red">',
    ]);
    // A block of HTML isn't text.
    expect(parseMarkdown('<span data-color="red">\n\ntext\n\n</span>\n').children[0]?.type).toBe(
      'html',
    );
  });

  it('write back as written', () => {
    for (const body of [
      '<span data-color="red">a **b**</span> c\n',
      'a <mark data-color="purple">b</mark>\n',
      '==<span data-color="green">a</span>==\n',
      '<span data-color="red">a <span data-color="blue">b</span></span>\n',
    ])
      expect(stringify(parseMarkdown(body)), body).toBe(body);
  });
});
