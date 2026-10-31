import {
  bannerAttachment,
  coverOf,
  pageOperations,
  reviseCover,
  type AttachmentRef,
  type BannerChoice,
  type ClientContext,
  type CoverChanges,
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
import { iconImage } from './icon-image';

type Shown = { cover: ShownCover; attachments: readonly AttachmentRef[] };

/**
 * The draft view's cover pickers. Changes go into the draft through the
 * editor (`revise`), so they save with its autosave, and the band shows
 * them at once. An uploaded image becomes one of the draft's attachments,
 * which the banner or icon names; the image it replaces is dropped with
 * it, unless the text shows it too.
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
  // Count banner and icon choices, so an upload that ends after one doesn't undo it.
  const bannerChoices = useRef(0);
  const iconChoices = useRef(0);
  const shown: Shown | null =
    chosen ?? (payload ? { cover: coverOf(payload), attachments: payload.attachments } : null);

  function apply(changes: CoverChanges, added?: AttachmentRef) {
    editor.current?.revise((current) => {
      let attachments = added ? [...current.attachments, added] : current.attachments;
      const cover = coverOf(current);
      const banner = bannerAttachment(cover);
      const replaced = [
        // Moving the focal point, height or fade keeps the banner's image.
        changes.banner !== undefined &&
          !(changes.banner?.kind === 'image' && changes.banner.attachmentId === banner) &&
          banner,
        // A new icon is always a new upload.
        changes.icon !== undefined && cover.icon?.attachmentId,
      ].filter((id) => typeof id === 'string');
      for (const old of replaced) {
        if (current.markdown.includes(`${ATTACHMENT_SCHEME}${old}`)) continue;
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

  /**
   * Resize, encrypt and upload an icon image, then show it in place of the
   * emoji or icon, unless another image, icon or emoji was chosen meanwhile.
   * Saves wait for it. Rejects with a message to show.
   */
  function uploadIcon(file: File): Promise<void> {
    const handle = editor.current;
    if (!handle) return Promise.resolve();
    const epoch = vaultStore.epoch();
    const choices = iconChoices.current;
    const work = (async () => {
      try {
        handle.checkSize();
        const ref = await pageOperations.uploadAttachment(ctx, page, await iconImage(file));
        if (vaultStore.epoch() !== epoch || iconChoices.current !== choices) return;
        apply({ icon: { attachmentId: ref.id }, symbol: null }, ref);
      } catch (caught) {
        throw new Error(uploadMessage(caught));
      }
    })();
    handle.track(work);
    return work;
  }

  return {
    shown,
    uploading,
    error,
    setBanner: (banner: BannerChoice | null) => {
      bannerChoices.current += 1;
      apply({ banner });
    },
    /** Choosing an emoji removes the image or icon; removing the emoji keeps them. */
    setEmoji: (emoji: string | null) => {
      if (emoji === null) return apply({ emoji });
      iconChoices.current += 1;
      apply({ emoji, icon: null, symbol: null });
    },
    /** Choosing an icon of the icon set removes the image; null removes the icon. */
    setSymbol: (name: string | null) => {
      iconChoices.current += 1;
      apply(name === null ? { symbol: null } : { symbol: { name }, icon: null });
    },
    uploadIcon,
    /** Remove the image, so the emoji shows again. */
    removeIcon: () => {
      iconChoices.current += 1;
      apply({ icon: null });
    },
    upload,
  };
}
