import { pickedCompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { foldPropertyName, splitFrontmatter, type PropertyData } from '@wikistow/client';
import { linkOptions, TYPING, TYPING_LINK } from '../link-completions';
import type { OtherPages } from '../../other-pages';
import {
  matchingProperties,
  REFERENCE_PAGE,
  referenceOptions,
  TYPING_REFERENCE,
} from '../property-completions';
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
 * A reference's page, after `` `= ``, gets the pages alone, in its code too.
 */
export function wikilinkCompletions(assist: () => LinkAssist): CompletionSource {
  return async (context) => {
    const match = context.matchBefore(TYPING_LINK);
    if (!match) return null;
    const line = context.state.doc.lineAt(match.from);
    const opening = context.state.sliceDoc(Math.max(line.from, match.from - 100), match.from);
    const inReference = REFERENCE_PAGE.test(opening) && !/``=[ \t]*$/.test(opening);
    if (!linkable(context.state, match.from, inReference)) return null;
    if (inReference && match.text.includes('#')) return null;
    const found = await linkOptions(match.text, assist(), () =>
      context.state.doc.sliceString(0, undefined, '\n'),
    );
    if (!found || context.aborted) return null;
    return {
      from: match.from + found.start,
      options: (inReference
        ? found.options.filter((option) => option.type === 'page')
        : found.options
      ).map(({ label, displayLabel, detail, type, text, accepted }): Completion => ({
        label,
        displayLabel,
        ...(detail === null ? {} : { detail }),
        type,
        // In a section of its own, which lists after the pages however well they match.
        ...(type === 'create' ? { section: 'New page' } : {}),
        apply: insertLink(text, accepted),
      })),
      validFor: TYPING,
    };
  };
}

// Whether a link may start at `from`: not an embed, and not in code, HTML
// or frontmatter (typed into a page without Properties), apart from a
// reference's page in its inline code (`inReference`).
function linkable(state: EditorState, from: number, inReference = false): boolean {
  if (from > 0 && state.sliceDoc(from - 1, from) === '!') return false;
  for (let node = syntaxTree(state).resolveInner(from, 1); ; node = node.parent) {
    if (NO_LINKS.has(node.name) && !(inReference && node.name === 'InlineCode')) return false;
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

// Syntax a reference can't be typed in: code blocks and HTML. Inline code
// is where one is.
const NO_REFERENCES = new Set([
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
]);

/**
 * Completions for a reference to a value: after `` `= `` (or
 * `` `= this. ``), the keys a reference can name, each with its value;
 * after `` `=[[Page]]. ``, that page's, as `others` has them. Accepting one
 * writes the key and the closing backtick, unless it's there.
 */
export function referenceCompletions(
  properties: () => readonly PropertyData[] | null | undefined,
  others: () => OtherPages | null | undefined = () => null,
): CompletionSource {
  return (context) => {
    const match = context.matchBefore(TYPING_REFERENCE);
    if (!match || !referable(context.state, match.from)) return null;
    const typed = TYPING_REFERENCE.exec(match.text);
    if (!typed) return null;
    const name = typed.groups?.['name'] ?? '';
    const options = matchingProperties(
      referenceOptions(typed, properties() ?? null, others() ?? null),
      name,
    );
    if (options.length === 0) return null;
    return {
      from: match.to - name.length,
      options: options.map(({ label, detail, text }): Completion => ({
        label,
        ...(detail === null ? {} : { detail }),
        type: 'property',
        apply: insertName(text),
      })),
      // Matched here as names match keys, and so asked again at each key.
      filter: false,
    };
  };
}

// Whether a reference may start at `from`: not in a code block, HTML or frontmatter.
function referable(state: EditorState, from: number): boolean {
  for (let node = syntaxTree(state).resolveInner(from, 1); ; node = node.parent) {
    if (NO_REFERENCES.has(node.name)) return false;
    if (!node.parent) break;
  }
  if (state.sliceDoc(0, 3) !== '---') return true;
  const { frontmatter } = splitFrontmatter(state.doc.sliceString(0, undefined, '\n'));
  return frontmatter === null || from >= frontmatter.length;
}

/**
 * Accepting a key: write it in place of the name typed, with the closing
 * backtick unless it's there, and go on after it. A name typed into keeps
 * none of its old rest: the rest of its word goes, if a backtick closes
 * it, and the rest up to the backtick past spaces too if it's how the key
 * ends (`` `=co|k time` `` with `cook_time`). Past a space, short of that,
 * the backtick may open other code, the text before it not the name's.
 */
function insertName(text: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const after = view.state.sliceDoc(to, to + 200);
    const word = /^[\p{L}\p{N}_-]*/u.exec(after)?.[0] ?? '';
    const rest = /^[\p{L}\p{N} _-]*(?=`)/u.exec(after)?.[0];
    const ends = (part: string) =>
      foldPropertyName(text).endsWith(foldPropertyName(part.trimEnd()));
    const end = rest !== undefined && (rest === word || ends(rest)) ? to + rest.length : to;
    const closed = view.state.sliceDoc(end, end + 1) === '`';
    view.dispatch({
      changes: { from, to: end, insert: closed ? text : `${text}\`` },
      selection: { anchor: from + text.length + 1 },
      userEvent: 'input.complete',
      annotations: pickedCompletion.of(completion),
    });
  };
}
