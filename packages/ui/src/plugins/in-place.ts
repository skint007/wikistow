// Views the app draws for plugins itself, a script's block form
// (`formView`), take new props in place: a page's properties changing
// shouldn't draw a form afresh, which would lose what's being typed in it,
// or in another block's form beside it. A plugin's own view can only be
// drawn again, as `View` has no way to update.

const views = new WeakSet<object>();
const updates = new WeakMap<HTMLElement, (props: unknown) => void>();

/** `view`, marked as one the app draws, which takes new props in place (`updateInPlace`). */
export function drawnByApp<V extends object>(view: V): V {
  views.add(view);
  return view;
}

/** Whether `view` is one the app draws, which takes new props in place rather than being drawn again. */
export const takesPropsInPlace = (view: object) => views.has(view);

/** How the view drawn into `element` takes new props in place, until the returned function ends it. */
export function updatedBy<P>(element: HTMLElement, update: (props: P) => void): () => void {
  const take = (props: unknown) => update(props as P);
  updates.set(element, take);
  return () => {
    if (updates.get(element) === take) updates.delete(element);
  };
}

/** Give the view drawn into `element` new props in place; false if it takes none that way. */
export function updateInPlace(element: HTMLElement, props: unknown): boolean {
  const update = updates.get(element);
  update?.(props);
  return update !== undefined;
}
