// Math as the reader shows it: TeX as MathML, from KaTeX, which browsers
// lay out with no styles, as the page's policy has it (`style-src 'self'`).
// Its own entry (`@wikistow/client/reader/math`), as KaTeX is large: the
// reader's worker (`markdownJobs.body`), the server's public pages and the
// visual editor's math load it; nothing else does.
import type { Element } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { sanitize, type Schema } from 'hast-util-sanitize';
import katex from 'katex';
import type { Root } from 'mdast';
import { markdownNodes } from '../markdown/index.ts';

// MathML Core's elements and the attributes KaTeX writes on them: no
// links, styles, classes or ids, and nothing else, nor the TeX.
const schema: Schema = {
  tagNames: [
    'math',
    'semantics',
    'mrow',
    'mi',
    'mn',
    'mo',
    'ms',
    'mtext',
    'mspace',
    'msup',
    'msub',
    'msubsup',
    'munder',
    'mover',
    'munderover',
    'mmultiscripts',
    'mprescripts',
    'none',
    'mfrac',
    'msqrt',
    'mroot',
    'mstyle',
    'mpadded',
    'mphantom',
    'menclose',
    'merror',
    'mtable',
    'mtr',
    'mtd',
    'mlabeledtr',
  ],
  attributes: {
    '*': [
      'accent',
      'accentunder',
      'columnalign',
      'columnlines',
      'columnspacing',
      'depth',
      'display',
      'displaystyle',
      'fence',
      'form',
      'height',
      'largeop',
      'linethickness',
      'lspace',
      'mathbackground',
      'mathcolor',
      'mathsize',
      'mathvariant',
      'maxsize',
      'minsize',
      'movablelimits',
      'notation',
      'rowalign',
      'rowlines',
      'rowspacing',
      'rspace',
      'scriptlevel',
      'separator',
      'stretchy',
      'symmetric',
      'voffset',
      'width',
    ],
  },
  // The TeX KaTeX keeps in the MathML, which a page's outline, a heading's
  // text and its word count would read as text.
  strip: ['annotation'],
};

/** TeX KaTeX can't read, as written, marked so. */
const unread = (tex: string): Element => ({
  type: 'element',
  tagName: 'code',
  properties: { className: ['math-error'] },
  children: [{ type: 'text', value: tex }],
});

/**
 * `tex` as a MathML `<math>` element, shown as a block if `display`; as
 * written, in a `code.math-error`, if KaTeX can't read it. Nothing it can
 * load or run: KaTeX trusts no `\href` or `\includegraphics`, and what it
 * writes is cut to `schema`.
 */
export function texElement(tex: string, display: boolean): Element {
  let html: string;
  try {
    html = katex.renderToString(tex, {
      output: 'mathml',
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
    });
  } catch {
    return unread(tex);
  }
  // KaTeX's `<span class="katex">` around it goes with the sanitizing.
  const clean = sanitize(fromHtml(html, { fragment: true }), schema);
  const [math] = clean.type === 'root' ? clean.children : [];
  return math?.type === 'element' && math.tagName === 'math' ? math : unread(tex);
}

/**
 * `tree`, each math node shown as its MathML (`texElement`): a block in a
 * `div.math-display`, inline math in a `span.math-inline`.
 */
export function renderMath(tree: Root): Root {
  for (const node of markdownNodes(tree)) {
    if (node.type !== 'math' && node.type !== 'inlineMath') continue;
    const display = node.type === 'math';
    node.data = {
      ...node.data,
      hName: display ? 'div' : 'span',
      hProperties: { className: ['math', display ? 'math-display' : 'math-inline'] },
      hChildren: [texElement(node.value, display)],
    };
  }
  return tree;
}
