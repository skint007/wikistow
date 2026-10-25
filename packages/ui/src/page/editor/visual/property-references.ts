import {
  findProperty,
  parsePropertyReference,
  propertyText,
  type PropertyData,
} from '@wikistow/client';
import type { Mark, Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { referenceHint, type OtherPages } from '../../other-pages';

// References to values (`` `=servings` ``, `` `=[[Page]].key` ``) in the
// visual editor (ADR 0006, decisions 4 and 5): the inline code stays as
// typed, a mark like any other, and decorations only show what it names,
// so neither the document nor what it writes changes. A value found shows
// in a chip after the code; a name or page not found is underlined,
// dashed, with a hint. Another page's value is as the editor's search
// index holds it; until that is built, its reference is left as it is.

const key = new PluginKey<DecorationSet>('propertyReferences');

const CHIP =
  'ml-1 rounded-row bg-folder-purple px-1.5 py-px font-sans text-[0.85em] font-semibold text-foreground select-none';
const UNKNOWN = 'underline decoration-border decoration-dashed underline-offset-4';
const UNKNOWN_HINT = 'No property has this name';
const NO_PAGE_HINT = 'No page has this title';

/**
 * The value a reference shows, as a chip drawn after the code, its hint
 * `hint`, above it in a link's text, as a link's hint is (`linkHint`).
 */
function chip(property: PropertyData, hint: string, inLink: boolean) {
  return () => {
    const dom = document.createElement('span');
    dom.className = CHIP;
    dom.contentEditable = 'false';
    dom.dataset['hint'] = hint;
    if (inLink) dom.dataset['hintSide'] = 'top';
    dom.setAttribute('aria-label', hint);
    dom.textContent = propertyText(property) || '–';
    return dom;
  };
}

/** Each reference in `doc`, decorated as `properties`, and `others` for other pages', say. */
function decorations(
  doc: Node,
  properties: readonly PropertyData[] | null,
  others: OtherPages | null,
): DecorationSet {
  const found: Decoration[] = [];
  // A run of inline code, which may be several text nodes as other marks change.
  // Whether any of it is in a link, and the marks of its end, where its chip goes.
  let run: {
    from: number;
    to: number;
    text: string;
    inLink: boolean;
    marks: readonly Mark[];
  } | null = null;
  const flush = () => {
    const reference = run && parsePropertyReference(run.text);
    const other = reference?.page ? others?.(reference.page) : undefined;
    // Another page's reference waits for the index, showing nothing meanwhile.
    if (run && reference && !(reference.page && other === undefined)) {
      const shown = reference.page
        ? other?.kind === 'page'
          ? other.properties
          : null
        : properties;
      const property = shown ? findProperty(shown, reference.name) : undefined;
      if (property) {
        const value = propertyText(property);
        const hint = referenceHint(property, other?.kind === 'page' ? other : undefined);
        // In the code's marks but its own, so it's in a link just where the code is,
        // not the next text's.
        const marks = run.marks.filter((mark) => mark.type.name !== 'inlineCode');
        const inLink = marks.some((mark) => mark.type.name === 'link');
        found.push(
          Decoration.widget(run.to, chip(property, hint, inLink), {
            side: 1,
            marks,
            ignoreSelection: true,
            key: `property:${hint}:${value}:${marks.map((mark) => mark.type.name).join(',')}`,
          }),
        );
      } else {
        const hint = other?.kind === 'none' ? NO_PAGE_HINT : UNKNOWN_HINT;
        found.push(
          Decoration.inline(run.from, run.to, {
            class: UNKNOWN,
            'data-hint': hint,
            ...(run.inLink ? { 'data-hint-side': 'top' } : {}),
            'aria-description': hint,
          }),
        );
      }
    }
    run = null;
  };
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!node.type.spec.code) {
      node.forEach((child, offset) => {
        const at = pos + 1 + offset;
        const code = child.isText && child.marks.some((mark) => mark.type.name === 'inlineCode');
        if (!code) return flush();
        const inLink = child.marks.some((mark) => mark.type.name === 'link');
        if (run && run.to === at) {
          run.to += child.nodeSize;
          run.text += child.text ?? '';
          run.inLink ||= inLink;
          run.marks = child.marks;
        } else {
          flush();
          run = {
            from: at,
            to: at + child.nodeSize,
            text: child.text ?? '',
            inLink,
            marks: child.marks,
          };
        }
      });
      flush();
    }
    return false;
  });
  return DecorationSet.create(doc, found);
}

/**
 * A transaction that changes nothing but tells the decorations the page's
 * properties, or the other pages its references name, changed.
 */
export const propertiesChanged = (tr: Transaction) => tr.setMeta(key, true);

/**
 * References to values decorated as `properties()`, the page's now, and
 * `others()`, the other pages as the editor's index has them now, say.
 */
export const propertyReferences = (
  properties: () => readonly PropertyData[] | null,
  others: () => OtherPages | null = () => null,
) =>
  $prose(
    () =>
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, { doc }) => decorations(doc, properties(), others()),
          apply: (tr, set) =>
            tr.docChanged || tr.getMeta(key) ? decorations(tr.doc, properties(), others()) : set,
        },
        props: { decorations: (state) => key.getState(state) },
      }),
  );
