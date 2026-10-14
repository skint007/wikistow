import { splitFrontmatter } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { joinPage, propertiesText, withProperties } from '../src/page/properties.ts';

const blocks = {
  LF: '---\ntags: [a, b]\nowner: "Olive"\n---\n',
  CRLF: '---\r\ntags: [a]\r\n---\r\n',
  'dots closing': '---\naliases: [one]\n...\n',
  'no final line break': '---\ntags: [a]\n---',
  empty: '---\n---\n',
};

describe('frontmatter in the draft view', () => {
  for (const name of ['CRLF', 'dots closing', 'no final line break'] as const) {
    it(`gives back a ${name} block byte for byte when its text is unchanged`, () => {
      expect(withProperties(blocks[name], propertiesText(blocks[name]))).toBe(blocks[name]);
    });
  }

  it('changes only what’s between the delimiters, in the block’s own line breaks', () => {
    expect(withProperties(blocks.CRLF, 'tags: [a]\nowner: x')).toBe(
      '---\r\ntags: [a]\r\nowner: x\r\n---\r\n',
    );
    expect(withProperties(blocks['dots closing'], '')).toBe('---\n...\n');
    expect(withProperties(blocks['no final line break'], 'b: 2')).toBe('---\nb: 2\n---');
  });

  it('joins the block and body back into the page they were split from', () => {
    for (const block of Object.values(blocks))
      for (const body of ['', 'Body\n', '\nText']) {
        const page = joinPage(block, body);
        expect(splitFrontmatter(page), JSON.stringify(page)).toEqual({
          // A closing line with no line break gets one once there's a body.
          frontmatter: body && !block.endsWith('\n') ? `${block}\n` : block,
          body,
        });
      }
    expect(joinPage(null, 'Body')).toBe('Body');
  });
});
