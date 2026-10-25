import { describe, expect, it } from 'vite-plus/test';
import { markdownLiteral, parsePropertyReference, publicLinkOperations } from '../src/index.ts';

describe('a reference to one of the page’s values', () => {
  it('is inline code naming a property, as WikiStow or Dataview writes it', () => {
    expect(parsePropertyReference('=servings')).toEqual({ name: 'servings' });
    expect(parsePropertyReference('= this.servings')).toEqual({ name: 'servings' });
    expect(parsePropertyReference('=this.cook time')).toEqual({ name: 'cook time' });
    expect(parsePropertyReference('=  cook_time ')).toEqual({ name: 'cook_time' });
    expect(parsePropertyReference('=Größe')).toEqual({ name: 'Größe' });
  });

  it('leaves code that names no property as code', () => {
    for (const code of [
      'servings',
      '=',
      '= ',
      '=SUM(A1:A3)',
      '=a.b',
      '=[[Page]].key',
      '==x',
      '=_x',
      '=x\ny',
    ]) {
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
      'Serves &#52; with &#115;oup\\, bread, from &#50;026\\-10\\-12, beside &#84;omato soup.\n\n' +
        'Not `=nothing`, nor `=SUM(A1:A3)`, but &#60;b\\>bold\\<\\/b\\>.\n',
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

describe('a value written as Markdown text', () => {
  it('escapes all ASCII punctuation, writes its first character as a reference, and keeps to one line', () => {
    expect(markdownLiteral('<a href="x">*hi*</a> | `c` [[p]] &amp;')).toBe(
      '&#60;a href\\=\\"x\\"\\>\\*hi\\*\\<\\/a\\> \\| \\`c\\` \\[\\[p\\]\\] \\&amp\\;',
    );
    expect(markdownLiteral('one\r\ntwo\tthree')).toBe('&#111;ne two three');
    expect(markdownLiteral(' edge ')).toBe('&#32;edge&#32;');
    expect(markdownLiteral('😀 Größe 4')).toBe('&#128512; Größe 4');
    expect(markdownLiteral('')).toBe('');
  });
});
