// Syntax highlighting for fenced code, by its language label, in the
// reader (in its worker, `markdownJobs.body`) and the visual editor
// (`packages/ui/src/page/editor/visual/highlight.ts`). Each token is a span
// with highlight.js's `hljs-` classes, coloured by the page's palette
// (`packages/ui/src/styles/app.css`).
import { markdownNodes } from '../markdown/index.ts';
import type { ElementContent } from 'hast';
import { common, createLowlight } from 'lowlight';
import type { Root } from 'mdast';

// highlight.js's common languages, `bash` (and `sh`), `ts`, `python`, `json`
// and `yaml` among them.
const lowlight = createLowlight(common);

/** The languages a code block can be given, by highlight.js's names, but plain text, which is none. */
export const CODE_LANGUAGES = lowlight.listLanguages().filter((name) => name !== 'plaintext');

/**
 * Code longer than this stays plain: highlighting it takes time with its
 * length, in the reader's worker and on each edit in the visual editor. A
 * block this long takes about 50 ms.
 */
export const HIGHLIGHT_LIMIT = 20_000;

/**
 * `code` as highlighted spans, by `language`, a fenced block's label; null
 * for a language highlight.js doesn't know, or code past `HIGHLIGHT_LIMIT`,
 * which stays plain.
 */
export function highlighted(code: string, language: string | null | undefined) {
  if (!language || code.length > HIGHLIGHT_LIMIT || !lowlight.registered(language)) return null;
  return lowlight
    .highlight(language, code)
    .children.filter((node): node is ElementContent => node.type !== 'doctype');
}

/** `tree`, each fenced block's code `highlighted` as the HTML it becomes. */
export function highlightCode(tree: Root): Root {
  for (const node of markdownNodes(tree)) {
    if (node.type !== 'code') continue;
    const spans = highlighted(node.value, node.lang);
    if (spans) node.data = { ...node.data, hChildren: spans };
  }
  return tree;
}
