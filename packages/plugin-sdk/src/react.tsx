import { Component, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { View } from './host.ts';

/**
 * A view drawing `Content` with the plugin's own React, in a root of its
 * own: plugins don't share the app's React or its components. A render
 * that throws shows a short note in its place.
 */
export function reactView<Props extends object>(Content: ComponentType<Props>): View<Props> {
  return (element, props) => {
    // A box of its own: the host clears its element at once, React unmounts later.
    const box = document.createElement('div');
    element.append(box);
    const root = createRoot(box);
    root.render(
      <Boundary>
        <Content {...props} />
      </Boundary>,
    );
    // Not while the host is rendering, which may be what removes the view.
    return () => queueMicrotask(() => root.unmount());
  };
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p role="alert">This view failed.</p> : this.props.children;
  }
}
