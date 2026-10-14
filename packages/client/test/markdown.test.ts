import { readdirSync, readFileSync } from 'node:fs';
import type { Nodes } from 'mdast';
import { fromMarkdown, type Extension } from 'mdast-util-from-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vite-plus/test';
import {
  findWikilinks,
  markdownNodes,
  parseMarkdown,
  parseWikilink,
  splitFrontmatter,
  wikilinkFromMarkdown,
  wikilinkSyntax,
  wikilinkToMarkdown,
  type WikilinkNode,
} from '../src/index.ts';
import { wikilinkFuzz } from './support/testing.ts';
import { growth } from './support/timing.ts';

const corpus = new URL('./corpus/', import.meta.url);
const samples = readdirSync(corpus)
  .sort()
  .map((name) => ({ name, markdown: readFileSync(new URL(name, corpus), 'utf8') }));

const stringify = (tree: Nodes) =>
  toMarkdown(tree, { extensions: [gfmToMarkdown(), wikilinkToMarkdown] });

// What the page says, with where each node sat left out.
const meaning = (body: string): unknown =>
  JSON.parse(
    JSON.stringify(parseMarkdown(body), (key, value) => (key === 'position' ? undefined : value)),
  );

const wikilinks = (body: string) =>
  [...markdownNodes(parseMarkdown(body))].filter(
    (node): node is WikilinkNode => node.type === 'wikilink',
  );

const sources = (body: string) => wikilinks(body).map((link) => link.source);

describe('the corpus through the shared syntax', () => {
  it('keeps every sample’s meaning, wikilinks and frontmatter', () => {
    for (const { name, markdown } of samples) {
      const { frontmatter, body } = splitFrontmatter(markdown);
      const again = stringify(parseMarkdown(body));
      expect(meaning(again), name).toEqual(meaning(body));
      expect(sources(again), name).toEqual(sources(body));
      expect((frontmatter ?? '') + body, name).toBe(markdown);
    }
  });
});

describe('the wikilink syntax', () => {
  const read = (body: string) =>
    wikilinks(body).map(({ source, target, heading, shown, embed, unsupported }) => ({
      source,
      target,
      heading,
      shown,
      embed,
      unsupported,
    }));

  it('reads each form, and marks the inert Obsidian ones', () => {
    expect(read('[[A/B#H|s]] ![[f.pdf]] ![[Page]] ![[#H]] [[P#^id]]')).toEqual([
      {
        source: '[[A/B#H|s]]',
        target: 'A/B',
        heading: 'H',
        shown: 's',
        embed: false,
        unsupported: null,
      },
      {
        source: '![[f.pdf]]',
        target: 'f.pdf',
        heading: null,
        shown: null,
        embed: true,
        unsupported: null,
      },
      {
        source: '![[Page]]',
        target: 'Page',
        heading: null,
        shown: null,
        embed: true,
        unsupported: 'page-embed',
      },
      {
        source: '![[#H]]',
        target: '',
        heading: 'H',
        shown: null,
        embed: true,
        unsupported: 'page-embed',
      },
      {
        source: '[[P#^id]]',
        target: 'P',
        heading: '^id',
        shown: null,
        embed: false,
        unsupported: 'block-ref',
      },
    ]);
  });

  it('writes a link’s bars escaped in a table cell, and only there', () => {
    const tree = parseMarkdown('| a |\n| - |\n| [[Q\\|y]] |\n\n[[P|x]]\n');
    for (const node of markdownNodes(tree))
      if (node.type === 'wikilink' && node.target === 'Q') node.source = '[[Q|y|z]]';
    const written = stringify(tree);
    expect(written).toBe('| a           |\n| ----------- |\n| [[Q\\|y\\|z]] |\n\n[[P|x]]\n');
    expect(sources(written)).toEqual(['[[Q\\|y\\|z]]', '[[P|x]]']);
    expect(stringify(parseMarkdown(written))).toBe(written);
  });
});

describe('the wikilink syntax on any input', () => {
  // Every token the syntax accepts, as the node builder is handed it.
  const accepted = (body: string) => {
    const tokens: string[] = [];
    const record: Extension = {
      enter: {
        wikilink(token) {
          tokens.push(this.sliceSerialize(token));
          this.enter({ type: 'text', value: '' }, token);
        },
      },
      exit: {
        wikilink(token) {
          this.exit(token);
        },
      },
    };
    fromMarkdown(body, {
      extensions: [gfm(), wikilinkSyntax],
      mdastExtensions: [gfmFromMarkdown(), record],
    });
    return tokens;
  };

  it('builds a node for exactly the tokens it accepts, and never throws', () => {
    for (const body of wikilinkFuzz(500)) {
      const nodes = wikilinks(body);
      expect(
        nodes.map((n) => n.source),
        JSON.stringify(body),
      ).toEqual(accepted(body));
      for (const { position: _, ...node } of nodes)
        expect(node).toEqual(parseWikilink(node.source));
      expect(() => findWikilinks(body)).not.toThrow();
    }
  }, 120_000);

  // A retry, so a loaded machine doesn't fail it; quadratic fails every try.
  it('reads in time linear in the length of the page', { retry: 2, timeout: 60_000 }, () => {
    // No bracket the syntax turns down closes: micromark alone takes
    // quadratic time over many `[x]` that are no link, whatever we add.
    const page =
      '[[a]] [[b|c]] ![[d.png]] [[e#f]] [[g\th ![[c|d#e [[f\t]] [[#i]] [[j `k` <l>]] [[m`n]] '.repeat(
        500,
      );
    const read = (text: string) => {
      fromMarkdown(text, { extensions: [wikilinkSyntax], mdastExtensions: [wikilinkFromMarkdown] });
    };
    // Eight times the page took 12 to 18 times as long when measured, a
    // little more than linear; quadratic would be 64.
    expect(growth(read, page, page.repeat(8), 3)).toBeLessThan(32);
  });
});

describe('splitting frontmatter', () => {
  const split = (markdown: string) => {
    const parts = splitFrontmatter(markdown);
    expect((parts.frontmatter ?? '') + parts.body).toBe(markdown);
    return parts;
  };

  it('keeps the block’s exact bytes, closed by --- or ...', () => {
    expect(split('---\na: 1\n---\n# Body\n')).toEqual({
      frontmatter: '---\na: 1\n---\n',
      body: '# Body\n',
    });
    expect(split('---\r\na: 1\r\n...\r\n\r\nBody')).toEqual({
      frontmatter: '---\r\na: 1\r\n...\r\n',
      body: '\r\nBody',
    });
    expect(split('---\n---\n')).toEqual({ frontmatter: '---\n---\n', body: '' });
    expect(split('---\na: 1\n---')).toEqual({ frontmatter: '---\na: 1\n---', body: '' });
  });
});
