import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import type { ElementContent } from 'hast';
import { highlighted } from '../../highlight';

/** A run of a code block's text, by offset in it, and the classes highlight.js gives it. */
type Token = { from: number; to: number; className: string };

// Each code block's tokens. An edit leaves the blocks it doesn't touch the
// same nodes, so only a block edited is highlighted again.
const known = new WeakMap<Node, readonly Token[]>();

function tokensOf(block: Node): readonly Token[] {
  const cached = known.get(block);
  if (cached) return cached;
  const language: unknown = block.attrs['language'];
  const tokens: Token[] = [];
  let at = 0;
  const walk = (nodes: readonly ElementContent[], classes: readonly string[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const to = at + node.value.length;
        if (classes.length > 0) tokens.push({ from: at, to, className: classes.join(' ') });
        at = to;
      } else if (node.type === 'element') {
        const { className } = node.properties;
        walk(
          node.children,
          Array.isArray(className) ? [...classes, ...className.map(String)] : classes,
        );
      }
    }
  };
  walk(highlighted(block.textContent, typeof language === 'string' ? language : null) ?? [], []);
  known.set(block, tokens);
  return tokens;
}

/** Each code block's tokens in `doc`, as decorations. */
function decorations(doc: Node): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') {
      for (const { from, to, className } of tokensOf(node))
        found.push(Decoration.inline(pos + 1 + from, pos + 1 + to, { class: className }));
    }
    // Text blocks hold no code blocks.
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, found);
}

const key = new PluginKey<DecorationSet>('codeHighlights');

/**
 * Fenced code highlighted by its language label, as the reader does
 * (`highlighted`): spans drawn over the text, which stays as typed.
 */
export const codeHighlights = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, { doc }) => decorations(doc),
        apply: (tr, set) => (tr.docChanged ? decorations(tr.doc) : set),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
);
