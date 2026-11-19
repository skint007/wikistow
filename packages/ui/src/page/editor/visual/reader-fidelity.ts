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
// other than GitHub's alerts (`alertOf`), which it keeps, comments
// (`%%`), and tags (`#tag`) starting a line, which Markdown escapes there.
// Math is read as math (`mathSyntax`), and highlights as highlights
// (`highlightSyntax`).
const LINE_STARTS = { tags: /^[ \t]*#[^\s#]/ };

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

// Marks as Markdown writes them: nodes around the text they cover, links
// among them.
const NESTING = new Set<string>([
  'link',
  'emphasis',
  'strong',
  'delete',
  'highlight',
  'colorHighlight',
  'textColor',
]);

// A tree as `byMarks` sees it: its own, and those it makes.
type Tree = {
  type: string;
  color?: string;
  value?: string;
  children?: Tree[];
  position?: unknown;
  runs?: { text?: string; node?: Tree; marks: string }[];
  marks?: string[];
};

// Inline content as `runsOf` reads it: text with the marks on it, or an
// inline node not text, with its marks. Each mark is named (`nameOf`).
type Run = { text: string; marks: string[] } | { node: Tree; marks: string[] };

// The nodes that say a node's children are inline content.
const INLINE = new Set([...NESTING, 'text', 'inlineCode', 'break']);
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'tableCell']);

// Spaces and line breaks, as the visual editor shows them (`shownOf`).
const SPACES = /([ \t\r\n]+)/;
const BLANK = /^[ \t\r\n]+$/;

// A mark by its type and what it holds, a link's address or a colour, in
// LF; a link by which of its block's links it is too.
const nameOf = (mark: object) =>
  JSON.stringify(mark, (_key, value: unknown) =>
    typeof value === 'string' ? withLf(value) : value,
  );

const sameMarks = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, i) => name === b[i]);

/**
 * `children`, inline content, as runs of text each with the set of marks
 * on it, so how the marks nest says nothing: `~~*a* b~~` reads as
 * `*~~a~~*~~ b~~`. Spaces and line breaks have none, as the editor shows
 * them; text beside text with the same marks is one run, so a colour's
 * HTML beside one of its colour is one, as the editor shows it. A mark
 * inside one the same is one. A link is numbered in turn, so one written
 * as two, or two as one, differs, and one around nothing but spaces, as
 * `[ ](u)`, is there all the same.
 * Code, and other inline nodes not text, are runs of their own with their
 * marks; the children of those may hold inline content of their own.
 * Null if HTML is inside a mark: it may open in one and close in another,
 * so how they nest says what it's around.
 */
function runsOf(children: readonly Tree[]): { runs: Run[]; atoms: Tree[] } | null {
  const runs: Run[] = [];
  const atoms: Tree[] = [];
  let links = 0;
  // How many runs not spaces there have been, for a link to tell whether it's around any.
  let solid = 0;
  const add = (text: string, marks: string[]) => {
    const last = runs.at(-1);
    if (last && 'text' in last && sameMarks(last.marks, marks)) last.text += text;
    else runs.push({ text, marks });
  };
  type At = { node: Tree; marks: string[] } | { ends: string; solid: number };
  const stack: At[] = [];
  for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, marks: [] });
  for (let at = stack.pop(); at; at = stack.pop()) {
    if ('ends' in at) {
      if (solid === at.solid) runs.push({ node: { type: 'empty' }, marks: [at.ends] });
      continue;
    }
    const { node, marks } = at;
    if (NESTING.has(node.type) && node.children) {
      const { children: inside, position: _position, ...mark } = node;
      const name = nameOf(node.type === 'link' ? { ...mark, link: ++links } : mark);
      const within = marks.includes(name) ? marks : [...marks, name].sort();
      if (node.type === 'link') stack.push({ ends: name, solid });
      for (let i = inside.length - 1; i >= 0; i--) stack.push({ node: inside[i]!, marks: within });
    } else if (node.type === 'text') {
      for (const part of (node.value ?? '').split(SPACES))
        if (BLANK.test(part)) add(part, []);
        else if (part) {
          add(part, marks);
          solid++;
        }
    } else if (node.type === 'break') {
      runs.push({ node: { type: 'break' }, marks: [] });
    } else {
      if (node.type === 'html' && marks.length > 0) return null;
      runs.push({ node, marks });
      atoms.push(node);
      solid++;
    }
  }
  return { runs, atoms };
}

/**
 * `tree`, the inline content of each of its nodes as runs of text by the
 * marks on them (`runsOf`), each mark by its place in a list of their
 * names, which the tree holds once; or, where HTML is inside a mark, with
 * its marks around the same text put in one order (`inOneOrder`). In
 * place, without recursion.
 */
function byMarks(tree: Root): Root {
  const root = tree as Tree;
  const read: { node: Tree; runs: Run[] }[] = [];
  const stack: Tree[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const { children } = node;
    if (!children) continue;
    const inline =
      INLINE_PARENTS.has(node.type) || children.some((child) => INLINE.has(child.type));
    const runs = inline ? runsOf(children) : null;
    if (runs) {
      read.push({ node, runs: runs.runs });
      for (const atom of runs.atoms) stack.push(atom);
    } else if (inline) inOneOrder(node);
    else for (const child of children) stack.push(child);
  }
  const names = new Set<string>();
  for (const { runs } of read)
    for (const run of runs) for (const name of run.marks) names.add(name);
  const table = [...names].sort();
  const index = new Map(table.map((name, i) => [name, i]));
  for (const { node, runs } of read) {
    delete node.children;
    node.runs = runs.map(({ marks, ...run }) => ({
      ...run,
      marks: marks.map((name) => index.get(name)).join(','),
    }));
  }
  root.marks = table;
  return tree;
}

// A colour's HTML, which the editor shows as one where two of a colour meet.
const COLORED = new Set(['textColor', 'colorHighlight']);

/** `children`, each colour's HTML beside one of the same colour made one, text where they meet joined. */
function joined(children: Tree[]): Tree[] {
  const out: Tree[] = [];
  for (const child of children) {
    const last = out.at(-1);
    const same = last && COLORED.has(child.type) && last.type === child.type;
    if (!last || !same || last.color !== child.color) {
      out.push(child);
      continue;
    }
    const inside = [...(last.children ?? [])];
    for (const next of child.children ?? []) {
      const end = inside.at(-1);
      if (end?.type === 'text' && next.type === 'text')
        inside[inside.length - 1] = { ...end, value: `${end.value ?? ''}${next.value ?? ''}` };
      else inside.push(next);
    }
    out[out.length - 1] = { ...last, children: inside };
  }
  return out;
}
const nestingKey = (node: Tree) => `${node.type}:${node.color ?? ''}`;
const byKey = (a: Tree, b: Tree) => nestingKey(a).localeCompare(nestingKey(b));

/**
 * `tree`, each run of marks one inside the other around the same text put
 * in one order, by type, so the order they're written in says nothing, and
 * a colour's HTML beside one of its colour made one (`joined`). In place,
 * without recursion.
 */
function inOneOrder(tree: Tree): void {
  const stack: Tree[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.children) node.children = joined(node.children);
    const children = node.children ?? [];
    for (const [i, child] of children.entries()) {
      // The marks around the same text, outermost first, and what they hold.
      const chain: Tree[] = [];
      let content = [child];
      for (let at = child; NESTING.has(at.type) && at.children;) {
        chain.push(at);
        content = at.children;
        const [only] = at.children;
        if (at.children.length !== 1 || !only) break;
        at = only;
      }
      if (chain.length < 2) {
        stack.push(child);
        continue;
      }
      const shells = chain.map((wrap) => ({ ...wrap })).sort(byKey);
      shells.forEach((shell, k) => (shell.children = shells[k + 1] ? [shells[k + 1]!] : content));
      children[i] = shells[0] ?? child;
      // The innermost, whose children may start runs of their own.
      stack.push(shells.at(-1) ?? child);
    }
  }
}

// What a tree says, without where each node sat, which line breaks it has,
// or how its marks nest.
const meaning = (tree: Root) =>
  JSON.stringify(byMarks(tree), (key, value: unknown) =>
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
