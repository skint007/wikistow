/** What a page shows and offers, from who is looking and the page's heads. Pure, so it is table-tested. */

export type PageHeads = {
  draftHead: string | null;
  publishedHead: string | null;
  publishedCount: number;
  draftChanges: boolean;
};

export type Viewer = { role: 'reader' | 'editor' | 'owner'; canPublish: boolean };

export type View = 'published' | 'draft';

export type Pill =
  | { kind: 'published'; label: string; current: boolean }
  | { kind: 'draft'; label: string; current: boolean }
  | { kind: 'not-published'; label: string; hint: string };

export type PageViewModel =
  | { found: false }
  | {
      found: true;
      view: View;
      /** The revision to show. */
      revision: string;
      /** Showing an older publication from history rather than the latest. */
      older: boolean;
      pills: Pill[];
      /**
       * `detach`: the page is published from another page, so it has no
       * draft until someone who can publish here detaches it (section 13).
       */
      actions: { edit: boolean; publish: boolean; done: boolean; detach: boolean };
    };

/**
 * Whether the page is a copy of another page unpublished where it is: it
 * has no draft and no publication, so an editor sees its last publication,
 * the newest in its history, which the caller loads for this.
 */
export const isUnpublishedCopy = (viewer: Viewer, heads: PageHeads) =>
  viewer.role !== 'reader' &&
  heads.draftHead === null &&
  heads.publishedHead === null &&
  heads.publishedCount > 0;

export function pageViewModel({
  viewer,
  heads,
  requested,
  lastPublished = null,
}: {
  viewer: Viewer;
  heads: PageHeads;
  /** From the URL: `?view=` and `?rev=` (a published version from history). */
  requested: { view?: View | undefined; rev?: string | undefined };
  /** For an unpublished copy (`isUnpublishedCopy`), the newest version in its history. */
  lastPublished?: string | null;
}): PageViewModel {
  const editor = viewer.role !== 'reader';
  const published = heads.publishedHead;
  const publishedPill = (current: boolean): Pill => ({
    kind: 'published',
    label: `Published v${heads.publishedCount}`,
    current,
  });

  // Readers see publications only; a page never published, or unpublished,
  // doesn't exist for them.
  const wantsDraft =
    editor && heads.draftHead !== null && (requested.view === 'draft' || !published);
  if (wantsDraft && heads.draftHead) {
    return {
      found: true,
      view: 'draft',
      revision: heads.draftHead,
      older: false,
      pills: [
        { kind: 'draft', label: 'Draft', current: true },
        published
          ? publishedPill(false)
          : {
              kind: 'not-published',
              // Unpublished: readers don't see it, though it was published before.
              ...(heads.publishedCount > 0
                ? {
                    label: 'Unpublished',
                    hint: 'Readers can’t see this page. Publish it to show it to them again.',
                  }
                : {
                    label: 'Not published yet',
                    hint: 'Readers can’t see this page until it’s published.',
                  }),
            },
      ],
      actions: { edit: false, publish: viewer.canPublish, done: published !== null, detach: false },
    };
  }
  // A copy unpublished here: readers don't see it, and it has no draft to
  // edit until someone who can publish here detaches it (section 13).
  if (isUnpublishedCopy(viewer, heads) && lastPublished !== null) {
    const revision = requested.rev ?? lastPublished;
    return {
      found: true,
      view: 'published',
      revision,
      older: revision !== lastPublished,
      pills: [
        {
          kind: 'not-published',
          label: 'Unpublished',
          hint: 'Readers can’t see this copy. Publishing to it again from its source, while it is still that page’s copy, or detaching it and publishing, brings it back.',
        },
      ],
      actions: { edit: false, publish: false, done: false, detach: viewer.canPublish },
    };
  }
  if (!published) return { found: false };

  const revision = requested.rev ?? published;
  const pills: Pill[] = [publishedPill(true)];
  if (editor && heads.draftChanges) {
    pills.push({ kind: 'draft', label: 'Draft has changes', current: false });
  }
  return {
    found: true,
    view: 'published',
    revision,
    older: revision !== published,
    pills,
    actions: {
      // A copy of another page has no draft to edit until it is detached.
      edit: editor && heads.draftHead !== null,
      publish: false,
      done: false,
      detach: editor && heads.draftHead === null && viewer.canPublish,
    },
  };
}
