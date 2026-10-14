import { EditorView } from '@milkdown/kit/prose/view';

// The ProseMirror view behind a visual editor's element, for tests that
// edit it with transactions. Each view is noted as it first asks for its
// props, while it's being made.

const views = new WeakMap<Element, EditorView>();
const someProp: EditorView['someProp'] = Reflect.get(EditorView.prototype, 'someProp');
EditorView.prototype.someProp = function (this: EditorView, ...args: unknown[]) {
  if (this.dom) views.set(this.dom, this);
  return Reflect.apply(someProp, this, args);
} as typeof someProp;

/** The view whose element is `dom`. */
export function viewOf(dom: Element): EditorView {
  const view = views.get(dom);
  if (!view) throw new Error('No editor view was made here');
  return view;
}
