import { PageTooLarge } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'conflict' | 'too-large' | 'error';

/**
 * Save edits shortly after typing stops: one second after the last change,
 * and at least every ten seconds while typing continues. One save runs at a
 * time; edits made during it wait for their own timer, or for `flush()`. A
 * conflict (someone else saved first, found by a save or reported with
 * `conflict()`) stops autosave until the person decides what to keep. An
 * edit too large to save (`PageTooLarge`) waits for the next, which is tried
 * as usual. Any other refusal stops autosave too, and `onStatus` gets it
 * with the `'error'` status, so the person can be told why.
 */
export class Autosave<T> {
  #status: SaveStatus = 'saved';
  #pending: { value: T } | null = null;
  #firstPendingAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;
  readonly #save: (value: T) => Promise<void>;
  readonly #onStatus: (status: SaveStatus, error?: unknown) => void;
  readonly #timing: { debounceMs: number; maxWaitMs: number };

  constructor(
    save: (value: T) => Promise<void>,
    onStatus: (status: SaveStatus, error?: unknown) => void,
    timing = { debounceMs: 1000, maxWaitMs: 10_000 },
  ) {
    this.#save = save;
    this.#onStatus = onStatus;
    this.#timing = timing;
  }

  get status(): SaveStatus {
    return this.#status;
  }

  #set(status: SaveStatus, error?: unknown) {
    this.#status = status;
    this.#onStatus(status, error);
  }

  /** Save the pending edit; with `chain`, then any edits made during the save too. */
  async #run(chain: boolean): Promise<void> {
    this.#clearTimer();
    if (this.#running) {
      await this.#running;
      return this.#run(chain);
    }
    const next = this.#pending;
    if (!next || this.#stopped) return;
    this.#pending = null;
    this.#firstPendingAt = null;
    this.#set('saving');
    let tooLarge = false;
    this.#running = this.#save(next.value).then(
      () => this.#set(this.#pending ? 'pending' : 'saved'),
      (error: unknown) => {
        // Keep the unsaved edit, so "save mine" can still use it.
        this.#pending ??= next;
        tooLarge = error instanceof PageTooLarge;
        if (tooLarge) return this.#set('too-large');
        this.#stopped = true;
        if (error instanceof ApiError && error.code === 'stale-head') this.#set('conflict');
        else this.#set('error', error);
      },
    );
    try {
      await this.#running;
    } finally {
      this.#running = null;
    }
    // A timer's save leaves newer edits to the timer `schedule` set for them,
    // or typing would save every round trip. One too large waits for the next
    // edit, whose timer saves it.
    if (chain && this.#pending && !this.#stopped && !tooLarge) return this.#run(true);
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** `value` is the latest edit: save it once typing pauses. */
  schedule(value: T) {
    this.#pending = { value };
    if (this.#stopped) return;
    this.#set('pending');
    const now = Date.now();
    this.#firstPendingAt ??= now;
    const wait = Math.min(
      this.#timing.debounceMs,
      this.#firstPendingAt + this.#timing.maxWaitMs - now,
    );
    this.#clearTimer();
    this.#timer = setTimeout(() => void this.#run(false), Math.max(0, wait));
  }

  /** Save anything outstanding now; resolves once it is stored (or failed). */
  flush(): Promise<void> {
    return this.#run(true);
  }

  /** Someone else saved first: stop saving, keeping any edit, until `resume()`. */
  conflict() {
    this.#clearTimer();
    this.#stopped = true;
    this.#set('conflict');
  }

  /** After a conflict is resolved: forget the stop, optionally with the edit still to save. */
  resume() {
    this.#stopped = false;
    this.#set(this.#pending ? 'pending' : 'saved');
  }

  /** The edit not yet saved, if any. */
  unsaved(): T | null {
    return this.#pending?.value ?? null;
  }

  /** A save has been sent and not yet answered. */
  isSaving(): boolean {
    return this.#running !== null;
  }

  isStopped(): boolean {
    return this.#stopped;
  }
}
