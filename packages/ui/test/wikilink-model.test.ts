import {
  markdownNodes,
  parseMarkdown,
  type LinkablePage,
  type WikilinkNode,
} from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { headingId } from '../src/page/heading-ids.ts';
import { readBody } from '../src/page/reading.ts';
import { wikilinkView, type WikilinkScope } from '../src/page/wikilink-model.ts';

const link = (source: string): WikilinkNode => {
  const node = [...markdownNodes(parseMarkdown(source))].find((n) => n.type === 'wikilink');
  if (node?.type !== 'wikilink') throw new Error(`${source} is no wikilink`);
  return node;
};

const pages: LinkablePage[] = [
  { id: 'p-self', title: 'This page', folders: [] },
  { id: 'p-plan', title: 'Release Plan', folders: ['Work'] },
  { id: 'p-notes-1', title: 'Notes', folders: ['Work'] },
  { id: 'p-notes-2', title: 'Notes', folders: ['Home'] },
];
const reader: WikilinkScope = {
  pages,
  selfId: 'p-self',
  attachments: [
    { id: 'a-photo', name: 'photo.png', mediaType: 'image/png' },
    { id: 'a-doc', name: 'spec.pdf', mediaType: 'application/pdf' },
  ],
  links: new Map(),
  editor: false,
};
const editor: WikilinkScope = { ...reader, editor: true };
const view = (source: string, scope = reader) => wikilinkView(link(source), scope);

describe('a wikilink in the reader', () => {
  it('follows a table entry naming a page in the viewer’s tree, under its current title', () => {
    const renamed = { ...reader, links: new Map([['old plan', 'p-plan']]) };
    expect(view('[[Old plan#Dates]]', renamed)).toEqual({
      kind: 'page',
      pageId: 'p-plan',
      hash: headingId('Dates'),
      text: 'Release Plan › Dates',
      name: 'Release Plan › Dates',
    });
    expect(view('[[Old plan|the plan]]', renamed)).toMatchObject({
      pageId: 'p-plan',
      text: 'the plan',
    });
    // An earlier choice between pages of one title.
    const chosen = { ...editor, links: new Map([['notes', 'p-notes-2']]) };
    expect(view('[[Notes]]', chosen)).toMatchObject({ kind: 'page', pageId: 'p-notes-2' });
  });
});

describe('the reader’s Markdown pipeline', () => {
  it('reads any wikilink-like text without failing', () => {
    for (const body of ['See [[\t]] here', 'ab[[\t|shown]]'])
      expect(() => readBody(body), JSON.stringify(body)).not.toThrow();
  });
});
