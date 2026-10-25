import {
  findProperty,
  parsePropertyReference,
  propertyText,
  type PropertyData,
} from '@wikistow/client';
import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

// References to the page's values (`` `=servings` ``) in the visual editor
// (ADR 0006, decision 4): the inline code stays as typed, a mark like any
// other, and decorations only show what it names, so neither the document
// nor what it writes changes. A name the page has shows its value in a chip
// after the code; one it hasn't is underlined, dashed, with a hint.

const key = new PluginKey<DecorationSet>('propertyReferences');

const CHIP =
  'ml-1 inline-block max-w-[24ch] truncate rounded-row bg-folder-purple px-1.5 align-baseline font-sans text-[0.85em] font-semibold text-foreground select-none';
const UNKNOWN = 'underline decoration-border decoration-dashed underline-offset-4';
const UNKNOWN_HINT = 'No property has this name';

/** The value `name` shows, as a chip drawn after the code. */
function chip(property: PropertyData) {
  return () => {
    const dom = document.createElement('span');
    const hint = `${property.key} · property`;
    dom.className = CHIP;
    dom.contentEditable = 'false';
    dom.dataset['hint'] = hint;
    dom.setAttribute('aria-label', hint);
    dom.textContent = propertyText(property) || '–';
    return dom;
  };
}

/** Each reference in `doc`, decorated as `properties` say. */
function decorations(doc: Node, properties: readonly PropertyData[] | null): DecorationSet {
  const found: Decoration[] = [];
  // A run of inline code, which may be several text nodes as other marks change.
  let run: { from: number; to: number; text: string } | null = null;
  const flush = () => {
    const reference = run && parsePropertyReference(run.text);
    if (run && reference) {
      const property = properties ? findProperty(properties, reference.name) : undefined;
      if (property) {
        const value = propertyText(property);
        found.push(
          Decoration.widget(run.to, chip(property), {
            side: 1,
            ignoreSelection: true,
            key: `property:${property.key}:${value}`,
          }),
        );
      } else {
        found.push(
          Decoration.inline(run.from, run.to, {
            class: UNKNOWN,
            'data-hint': UNKNOWN_HINT,
            'aria-description': UNKNOWN_HINT,
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
        if (run && run.to === at) {
          run.to += child.nodeSize;
          run.text += child.text ?? '';
        } else {
          flush();
          run = { from: at, to: at + child.nodeSize, text: child.text ?? '' };
        }
      });
      flush();
    }
    return false;
  });
  return DecorationSet.create(doc, found);
}

/** A transaction that changes nothing but tells the decorations the page's properties changed. */
export const propertiesChanged = (tr: Transaction) => tr.setMeta(key, true);

/** References to the page's values decorated as `properties()`, the page's now, say. */
export const propertyReferences = (properties: () => readonly PropertyData[] | null) =>
  $prose(
    () =>
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, { doc }) => decorations(doc, properties()),
          apply: (tr, set) =>
            tr.docChanged || tr.getMeta(key) ? decorations(tr.doc, properties()) : set,
        },
        props: { decorations: (state) => key.getState(state) },
      }),
  );
