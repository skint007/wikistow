import { pickedCompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { splitFrontmatter } from '@wikistow/client';
import { linkOptions, TYPING, TYPING_LINK } from '../link-completions';
import type { LinkAssist } from '../surface';

// Syntax that holds no links: code and HTML. Frontmatter holds none either.
const NO_LINKS = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
]);

/**
 * Completions for wikilinks (`linkOptions`): after `[[`, the pages a link
 * here may name, by title, then "Create page" for a title none of them
 * has; after `#`, the headings of the page the link names. Nothing inside
 * code, HTML or frontmatter, nor for an embed (`![[`). A paragraph past
 * `INLINE_LIMIT` reads as plain text, so its code and HTML get them too.
 */
export function wikilinkCompletions(assist: () => LinkAssist): CompletionSource {
  return async (context) => {
    const match = context.matchBefore(TYPING_LINK);
    if (!match || !linkable(context.state, match.from)) return null;
    const found = await linkOptions(match.text, assist(), () =>
      context.state.doc.sliceString(0, undefined, '\n'),
    );
    if (!found || context.aborted) return null;
    return {
      from: match.from + found.start,
      options: found.options.map(
        ({ label, displayLabel, detail, type, text, accepted }): Completion => ({
          label,
          displayLabel,
          ...(detail === null ? {} : { detail }),
          type,
          // In a section of its own, which lists after the pages however well they match.
          ...(type === 'create' ? { section: 'New page' } : {}),
          apply: insertLink(text, accepted),
        }),
      ),
      validFor: TYPING,
    };
  };
}

// Whether a link may start at `from`: not an embed, and not in code, HTML
// or frontmatter (typed into a page without Properties).
function linkable(state: EditorState, from: number): boolean {
  if (from > 0 && state.sliceDoc(from - 1, from) === '!') return false;
  for (let node = syntaxTree(state).resolveInner(from, 1); ; node = node.parent) {
    if (NO_LINKS.has(node.name)) return false;
    if (!node.parent) break;
  }
  if (state.sliceDoc(0, 3) !== '---') return true;
  const { frontmatter } = splitFrontmatter(state.doc.sliceString(0, undefined, '\n'));
  return frontmatter === null || from >= frontmatter.length;
}

/**
 * Accepting an option: write `text` as the link's target or heading, with
 * the closing `]]` unless it's already there, and go on after it.
 */
function insertLink(text: string, accepted?: () => void) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 2) === ']]';
    view.dispatch({
      changes: { from, to, insert: closed ? text : `${text}]]` },
      selection: { anchor: from + text.length + 2 },
      userEvent: 'input.complete',
      annotations: pickedCompletion.of(completion),
    });
    accepted?.();
  };
}
