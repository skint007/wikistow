// The reader's side of the visual editor's fidelity check (`fidelityOf`):
// what the reader reads a body as, and the syntax the editor has no nodes
// for. No Milkdown or React here: the Markdown worker loads this
// (`markdown-jobs.ts`), so the check's reads run off the page's thread.
import { markdownNodes, parseMarkdown } from '@wikistow/client/markdown';
import { ALERTS, alertOf, syntaxReadings } from '@wikistow/client/reader';
import type { Nodes, Root } from 'mdast';

/** Whether a page body can be edited visually, and if not, why it stays in source mode. */
export type Fidelity = { visual: true } | { visual: false; reason: string };

/** Why a page body stays in source mode. */
export type Unkept = Extract<Fidelity, { visual: false }>;

// The mdast the CommonMark and GFM presets have nodes for. Reference
// links and their definitions aren't among them: Milkdown writes the links
// inline and drops the definitions.
const PRESET_TYPES = new Set<string>([
  'root',
  'paragraph',
  'heading',
  'thematicBreak',
  'blockquote',
  'list',
  'listItem',
  'code',
  'html',
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'break',
  'link',
  'image',
  'table',
  'tableRow',
  'tableCell',
  'footnoteDefinition',
  'footnoteReference',
]);

const visualTypes = new Set([...PRESET_TYPES, ...syntaxReadings.map((syntax) => syntax.type)]);

const REFERENCES = new Set<string>(['definition', 'linkReference', 'imageReference']);

export const stays = (what: string): Unkept => ({
  visual: false,
  reason: `This page stays in source mode, because the visual editor would change its ${what}.`,
});

// Obsidian syntax that Markdown reads as text, which the visual editor would
// write back escaped, or edit as if it were text: callouts (`> [!note]`)
// other than GitHub's alerts (`alertOf`), which it keeps,
// math (`$x$`, `$$`), comments (`%%`), and tags (`#tag`) and highlights
// (`==text==`) starting a line, which Markdown escapes there.
const INLINE_MATH = /\$\$|\$[^\s$](?:[^$\n]*[^\s$])?\$(?!\d)/;
const LINE_STARTS = { tags: /^[ \t]*#[^\s#]/, highlights: /^[ \t]*==[^\s=]/ };

const CALLOUT = /^\[!([^\]\n]*)\]?/;

/**
 * Why a quote whose text starts `text`, the page from its callout's marker
 * on, stays in source mode, naming the marker as written: a type GitHub
 * has no alert for (`[!INFO]`), or one with more on its line
 * (`[!note] Title`, `[!note]-`).
 */
function calloutReason(text: string): Unkept {
  const line = text.split(/\r?\n/, 1)[0]?.trimEnd() ?? '';
  const [marker = line, type = ''] = CALLOUT.exec(line) ?? [];
  const because = Object.hasOwn(ALERTS, type.toLowerCase())
    ? `only edits callouts with the marker alone on its line, and this page has ${line.length > 40 ? `${line.slice(0, 40)}…` : line}`
    : `only edits Note, Tip, Important, Warning and Caution callouts, and this page has ${marker}`;
  return {
    visual: false,
    reason: `This page stays in source mode, because the visual editor ${because}.`,
  };
}

function obsidianSyntax(tree: Root, body: string): Unkept | null {
  const raw = (node: Nodes) => body.slice(node.position?.start.offset, node.position?.end.offset);
  for (const node of markdownNodes(tree)) {
    if (node.type === 'blockquote') {
      const [first] = node.children;
      const [text] = first?.type === 'paragraph' ? first.children : [];
      const from = text?.type === 'text' ? text.position?.start.offset : undefined;
      // The marker's whole line, which may hold more than its text, as a title in bold.
      const callout = from !== undefined && body.startsWith('[!', from) && !alertOf(node);
      if (callout) return calloutReason(body.slice(from));
    }
    if (!('children' in node)) continue;
    for (const [i, child] of node.children.entries()) {
      if (child.type !== 'text') continue;
      const text = raw(child);
      if (text.includes('%%')) return stays('comments');
      if (INLINE_MATH.test(text)) return stays('math');
      // The text's lines that start a line of the page.
      const lines = text.split('\n').slice(i === 0 && node.type === 'paragraph' ? 0 : 1);
      for (const [what, pattern] of Object.entries(LINE_STARTS))
        if (lines.some((line) => pattern.test(line))) return stays(what);
    }
  }
  return null;
}

/**
 * `markdown` with every line break LF, which Markdown reads the same, as the
 * visual editor is given it: Milkdown keeps a CR in code and HTML, which
 * `asPage` would double.
 */
export const withLf = (markdown: string) => markdown.replace(/\r\n?/g, '\n');

// What a tree says, without where each node sat or which line breaks it has.
const meaning = (tree: Root) =>
  JSON.stringify(tree, (key, value: unknown) =>
    key === 'position' ? undefined : typeof value === 'string' ? withLf(value) : value,
  );

export const TOO_DEEP: Unkept = {
  visual: false,
  reason: 'This page stays in source mode, because it is nested too deeply to show formatted.',
};

/** What the reader reads `markdown` as (`meaning`); it throws if nested past the parser's stack. */
export const meaningOf = (markdown: string) => meaning(parseMarkdown(markdown));

/**
 * What the reader reads `body` (frontmatter split off) as (`meaning`), for
 * the visual editor's writing of it to read the same, if it holds only
 * syntax the editor has nodes for; else why it stays in source mode.
 */
export function readerFidelity(body: string): { meaning: string } | Unkept {
  // Read, walked or written out past the stack: nested too deep either way.
  try {
    const before = parseMarkdown(body);
    for (const node of markdownNodes(before)) {
      if (REFERENCES.has(node.type)) return stays('reference links');
      if (!visualTypes.has(node.type)) return stays('formatting');
    }
    return obsidianSyntax(before, body) ?? { meaning: meaning(before) };
  } catch {
    return TOO_DEEP;
  }
}
