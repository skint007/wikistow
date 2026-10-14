import {
  bannerAttachment,
  coverOf,
  pageOperations,
  reviseCover,
  type AttachmentRef,
  type BannerChoice,
  type ClientContext,
  type PagePayload,
  type ShownCover,
} from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type RefObject } from 'react';
import { uploadMessage } from '../messages';
import { vaultStore } from '../../vault/store';
import { ATTACHMENT_SCHEME, forgetDecrypted } from '../attachments';
import type { DraftEditorHandle } from '../draft-editor';
import { bannerImage } from './banner-image';

type Shown = { cover: ShownCover; attachments: readonly AttachmentRef[] };

/**
 * The draft view's cover pickers. Changes go into the draft through the
 * editor (`revise`), so they save with its autosave, and the band shows
 * them at once. An uploaded image becomes one of the draft's attachments,
 * which the banner names; the image it replaces is dropped with it, unless
 * the text shows it too.
 */
export function useCoverEditor({
  ctx,
  page,
  payload,
  editor,
}: {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  /** The draft as opened, before any change made here. */
  payload: PagePayload | null;
  editor: RefObject<DraftEditorHandle | null>;
}) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<Shown | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts banner choices, so an upload that ends after one doesn't undo it.
  const bannerChoices = useRef(0);
  const shown: Shown | null =
    chosen ?? (payload ? { cover: coverOf(payload), attachments: payload.attachments } : null);

  function apply(
    changes: { emoji?: string | null; banner?: BannerChoice | null },
    added?: AttachmentRef,
  ) {
    editor.current?.revise((current) => {
      let attachments = added ? [...current.attachments, added] : current.attachments;
      const old = bannerAttachment(coverOf(current));
      const replaced =
        old !== null &&
        changes.banner !== undefined &&
        (changes.banner?.kind !== 'image' || changes.banner.attachmentId !== old) &&
        !current.markdown.includes(`${ATTACHMENT_SCHEME}${old}`);
      if (replaced) {
        const ref = attachments.find((a) => a.id === old);
        attachments = attachments.filter((a) => a.id !== old);
        if (ref) forgetDecrypted(queryClient, { page, audience: 'draft' }, ref);
      }
      const extensions = reviseCover(current.extensions, changes);
      setChosen({
        cover: coverOf({ attachments, extensions: { ...current.extensions, ...extensions } }),
        attachments,
      });
      return { extensions, attachments };
    });
  }

  /**
   * Resize, encrypt and upload an image, then make it the banner, unless
   * another was chosen meanwhile. Saves wait for it.
   */
  function upload(file: File) {
    const handle = editor.current;
    if (!handle) return;
    setUploading(true);
    setError(null);
    // An upload that outlives the keys adds nothing: there are none to save it with.
    const epoch = vaultStore.epoch();
    // The image an upload overtaken this way makes is never listed, so it goes unused.
    const choices = bannerChoices.current;
    const work = (async () => {
      try {
        handle.checkSize();
        const ref = await pageOperations.uploadAttachment(ctx, page, await bannerImage(file));
        if (vaultStore.epoch() !== epoch || bannerChoices.current !== choices) return;
        apply({ banner: { kind: 'image', attachmentId: ref.id, focal: 50 } }, ref);
      } catch (caught) {
        setError(uploadMessage(caught));
      } finally {
        setUploading(false);
      }
    })();
    handle.track(work);
  }

  return {
    shown,
    uploading,
    error,
    setBanner: (banner: BannerChoice | null) => {
      bannerChoices.current += 1;
      apply({ banner });
    },
    setEmoji: (emoji: string | null) => apply({ emoji }),
    upload,
  };
}
