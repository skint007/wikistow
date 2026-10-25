// Where the visual editor shows each query block's result (ADR 0006,
// decision 7): under its code, which stays as written. A block's view adds
// an element outside its text and says what the block holds; the surface
// draws each result into its element with a React portal, so the table has
// the app's router and queries, and the document never changes.

/** One query block's place for its result, and its text now. */
export type QueryResult = { key: number; element: HTMLElement; source: string };

/** The query blocks on screen, which the surface draws results for. */
export class QueryResults {
  #shown: readonly QueryResult[] = [];
  readonly #listeners = new Set<() => void>();
  #next = 0;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** The blocks now, a new array after each change. */
  list = (): readonly QueryResult[] => this.#shown;

  #set(shown: readonly QueryResult[]) {
    this.#shown = shown;
    for (const listener of this.#listeners) listener();
  }

  /** A place for a block's result in `element`; its handle sets its text, or takes it away. */
  add(element: HTMLElement, source: string) {
    const key = ++this.#next;
    this.#set([...this.#shown, { key, element, source }]);
    return {
      set: (next: string) => {
        if (this.#shown.find((shown) => shown.key === key)?.source === next) return;
        this.#set(
          this.#shown.map((shown) => (shown.key === key ? { ...shown, source: next } : shown)),
        );
      },
      remove: () => this.#set(this.#shown.filter((shown) => shown.key !== key)),
    };
  }
}
