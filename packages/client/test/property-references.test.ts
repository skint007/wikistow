import { describe, expect, it } from 'vite-plus/test';
import {
  markdownLiteral,
  mayReferOtherPages,
  parsePropertyReference,
  publicLinkOperations,
  type PropertyData,
  type Wikilink,
} from '../src/index.ts';

describe('a reference to another page’s value', () => {
  it('is `=[[Page]].name`: a link to the page by its title, then the name', () => {
    const page = (target: string, start = 1) => ({
      source: `[[${target}]]`,
      target,
      heading: null,
      shown: null,
      embed: false,
      start,
      end: start + target.length + 4,
    });
    expect(parsePropertyReference('=[[Garlic bread]].cook_time')).toEqual({
      name: 'cook_time',
      page: page('Garlic bread'),
    });
    expect(parsePropertyReference('= [[Recipes/Garlic bread]]. cook time ')).toEqual({
      name: 'cook time',
      page: page('Recipes/Garlic bread', 2),
    });
  });

  it('leaves anything else as code, links with a heading, text or embed included', () => {
    for (const code of [
      '=[[Page]]',
      '=[[Page]].',
      '=[[Page]]key',
      '=[[Page]].SUM(A1)',
      '=[[Page#Dates]].key',
      '=[[Page|text]].key',
      '=![[Page]].key',
      '=[[#Dates]].key',
      '=[[]].key',
      '=[[Page#^block]].key',
      '=[[a\nb]].key',
      '=[[[Page]]].key',
      '= this.[[Page]].key',
      '[[Page]].key',
    ]) {
      expect(parsePropertyReference(code), code).toBe(null);
    }
  });

  it('is told apart from other text by `=[[`', () => {
    expect(mayReferOtherPages('see `=[[Page]].x`')).toBe(true);
    expect(mayReferOtherPages('see `= \t[[Page]].x`')).toBe(true);
    expect(mayReferOtherPages('see `=servings` and [[Page]]')).toBe(false);
  });
});

describe('a reference to one of the page’s values', () => {
  it('is inline code naming a property, as WikiStow or Dataview writes it', () => {
    expect(parsePropertyReference('=servings')).toEqual({ name: 'servings' });
    expect(parsePropertyReference('= this.servings')).toEqual({ name: 'servings' });
    expect(parsePropertyReference('=this.cook time')).toEqual({ name: 'cook time' });
    expect(parsePropertyReference('=  cook_time ')).toEqual({ name: 'cook_time' });
    expect(parsePropertyReference('=Größe')).toEqual({ name: 'Größe' });
  });

  it('leaves code that names no property as code', () => {
    for (const code of ['servings', '=', '= ', '=SUM(A1:A3)', '=a.b', '==x', '=_x', '=x\ny']) {
      expect(parsePropertyReference(code), code).toBe(null);
    }
  });
});

const PAGE = `---
servings: 4 # people
tags: [soup, bread]
created: 2026-10-12
goes_with: "[[Tomato soup]]"
evil: "<b>bold</b>"
---
Serves \`=servings\` with \`= this.tags\`, from \`=created\`, beside \`=goes with\`.

Not \`=nothing\`, nor \`=SUM(A1:A3)\`, but \`=evil\`.
`;

describe('a public copy’s body', () => {
  it('writes each of the page’s values in as text, its frontmatter left out', () => {
    expect(publicLinkOperations.copyBody(PAGE)).toBe(
      'Serves &#52; with &#115;oup\\, brea&#100;, from &#50;026\\-10\\-1&#50;, beside &#84;omato sou&#112;.\n\n' +
        'Not `=nothing`, nor `=SUM(A1:A3)`, but &#60;b\\>bold\\<\\/b&#62;.\n',
    );
  });

  it('is the body as written for a page without properties, or whose block doesn’t read', () => {
    expect(publicLinkOperations.copyBody('Serves `=servings`.\n')).toBe('Serves `=servings`.\n');
    expect(publicLinkOperations.copyBody('---\n- a\n---\nServes `=servings`.\n')).toBe(
      'Serves `=servings`.\n',
    );
  });

  it('leaves code in a code block, and code spans that aren’t references, as written', () => {
    const page = '---\nx: 1\n---\n```\n`=x`\n```\n\n``=x`` and `` `=x` ``\n';
    expect(publicLinkOperations.copyBody(page)).toBe('```\n`=x`\n```\n\n&#49; and `` `=x` ``\n');
  });
});

describe('a public copy’s values from other pages', () => {
  const others = (link: Wikilink): PropertyData[] | undefined =>
    link.target.toLowerCase() === 'garlic bread'
      ? [
          { key: 'cook_time', type: 'number', value: 35 },
          { key: 'evil', type: 'text', value: '<img src=x onerror=alert(1)> | a\nb' },
          { key: 'made', type: 'date', value: '2026-10-12' },
        ]
      : undefined;

  it('writes each in from what `others` gives, escaped, and leaves the rest as written', () => {
    const page =
      'Bake `=[[Garlic bread]].cook_time` min, `= [[garlic bread]].made`, `=[[Garlic bread]].evil`.\n\n' +
      'Not `=[[Garlic bread]].nothing`, `=[[Secret]].cook_time` or `=[[Garlic bread#x]].cook_time`.\n';
    expect(publicLinkOperations.copyBody(page, others)).toBe(
      'Bake &#51;&#53; min, &#50;026\\-10\\-1&#50;, &#60;img src\\=x onerror\\=alert\\(1\\)\\> \\| a &#98;.\n\n' +
        'Not `=[[Garlic bread]].nothing`, `=[[Secret]].cook_time` or `=[[Garlic bread#x]].cook_time`.\n',
    );
  });

  it('leaves every one as written without `others`, in a page with properties or without', () => {
    const body = 'Bake `=[[Garlic bread]].cook_time` min.\n';
    expect(publicLinkOperations.copyBody(body)).toBe(body);
    expect(publicLinkOperations.copyBody(`---\ncook_time: 9\n---\n${body}`)).toBe(body);
  });

  it('says what a copy shows of other pages', () => {
    expect(publicLinkOperations.fromOtherPages('`=[[Garlic bread]].cook_time`')).toEqual({
      values: true,
    });
    for (const markdown of [
      '---\nx: "[[Garlic bread]]"\n---\n`=x` [[Garlic bread]]',
      '```\n`=[[Garlic bread]].cook_time`\n```',
      '`=[[Garlic bread#x]].cook_time`',
    ]) {
      expect(publicLinkOperations.fromOtherPages(markdown), markdown).toEqual({ values: false });
    }
  });
});

describe('the text beside a value written in', () => {
  it('escapes a `<` that a code span kept from starting a tag, and nothing else', () => {
    // `</a>` and `<c>` after an escaped backslash are HTML as written, and stay so.
    const body = '<a href=`=v`>go</a> \\<b> \\\\<c> `<d>`\n\n<e>\n';
    expect(publicLinkOperations.copyBody(`---\nv: x\n---\n${body}`)).toBe(
      '\\<a href=&#120;>go</a> \\<b> \\\\<c> `<d>`\n\n<e>\n',
    );
  });
});

describe('a value written as Markdown text', () => {
  it('escapes all ASCII punctuation, writes its first character as a reference, and keeps to one line', () => {
    expect(markdownLiteral('<a href="x">*hi*</a> | `c` [[p]] &amp;')).toBe(
      '&#60;a href\\=\\"x\\"\\>\\*hi\\*\\<\\/a\\> \\| \\`c\\` \\[\\[p\\]\\] \\&amp&#59;',
    );
    expect(markdownLiteral('one\r\ntwo\tthree')).toBe('&#111;ne two thre&#101;');
    expect(markdownLiteral(' edge ')).toBe('&#32;edge&#32;');
    expect(markdownLiteral('😀 Größe 4')).toBe('&#128512; Größe &#52;');
    expect(markdownLiteral('')).toBe('');
    expect(markdownLiteral('x')).toBe('&#120;');
  });
});
