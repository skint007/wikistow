import type { Audience, PageId, RevisionId, SpaceId } from '@wikistow/contracts';
import type { OpenedRevision } from './operations/records.ts';

/** Content is immutable; region and keyVersion are only those last opened. Writes must fetch fresh. */
export class RevisionCache {
  #entries = new Map<RevisionId, { revision: OpenedRevision; bytes: number }>();
  #bytes = 0;
  #generation = 0;
  #closed = false;

  readonly maxBytes: number;

  constructor(maxBytes = 32 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Capture before asynchronous work, so a clear also drops its late results. */
  get generation(): number {
    return this.#generation;
  }

  get(wanted: {
    spaceId: SpaceId;
    pageId: PageId;
    audience: Audience;
    revisionId: RevisionId;
  }): OpenedRevision | undefined {
    const entry = this.#entries.get(wanted.revisionId);
    if (!entry) return;
    const { record } = entry.revision;
    if (
      record.spaceId !== wanted.spaceId ||
      record.pageId !== wanted.pageId ||
      record.audience !== wanted.audience
    )
      return;
    this.#entries.delete(wanted.revisionId);
    this.#entries.set(wanted.revisionId, entry);
    return structuredClone(entry.revision);
  }

  /** Keep successful openings only, detached from objects callers may edit. */
  put(revision: OpenedRevision, generation = this.#generation): void {
    if (this.#closed || generation !== this.#generation) return;
    const id = revision.record.revisionId;
    const previous = this.#entries.get(id);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(id);
    }
    // UTF-16 text, attachments and extensions, plus room for the record and entry.
    const bytes = JSON.stringify(revision.opened).length * 2 + 1024;
    if (bytes > this.maxBytes) return;
    this.#entries.set(id, { revision: structuredClone(revision), bytes });
    this.#bytes += bytes;
    for (const [oldId, entry] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      this.#entries.delete(oldId);
      this.#bytes -= entry.bytes;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#generation += 1;
  }

  /** A closed context is never reopened; unlocking creates a new session and cache. */
  close(): void {
    this.#closed = true;
    this.clear();
  }
}
