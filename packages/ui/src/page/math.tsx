import type { Element } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { InlineMath, MathBlock } from '@wikistow/client/markdown';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

/**
 * Math in the reader, as its worker rendered it (`renderMath`): MathML, in a
 * `div.math-display` for a block or a `span.math-inline`. Unrendered, it's
 * its TeX as code, as remark-math leaves it.
 */
export function MathReader({ node }: { node: MathBlock | InlineMath }) {
  const { hName = 'code', hProperties = {}, hChildren } = node.data ?? {};
  const element: Element = {
    type: 'element',
    tagName: hName,
    properties: hProperties,
    children: hChildren ?? [{ type: 'text', value: node.value }],
  };
  return toJsxRuntime(element, { Fragment, jsx, jsxs });
}
