import { pageOperations, type AttachmentRef, type ClientContext } from '@wikistow/client';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { ImageOff, Paperclip } from 'lucide-react';
import { PLAIN, vaultStore } from '../vault/store';
import { InLink } from './body-context';

/** Links and images to attachments use `attachment:<id>`, resolved from the page's own list. */
export const ATTACHMENT_SCHEME = 'attachment:';

export type AttachmentContext = {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  audience: 'draft' | 'published';
  attachments: readonly AttachmentRef[];
};

export const attachmentId = (url: string | undefined) =>
  url?.startsWith(ATTACHMENT_SCHEME) ? url.slice(ATTACHMENT_SCHEME.length) : null;

// Per page and reference: another page's reference to the same bytes must
// open with its own key, not reuse what this one decrypted.
const decryptedKey = (
  attachments: Pick<AttachmentContext, 'page' | 'audience'>,
  ref: AttachmentRef | undefined,
) => [PLAIN, 'attachment', attachments.page.pageId, attachments.audience, ref?.id, ref?.blobHash];

/** The query for a `blob:` URL of one of the page's attachments, decrypted here and kept until the vault locks. */
export const decryptedQuery = (
  attachments: Omit<AttachmentContext, 'attachments'>,
  ref: AttachmentRef | undefined,
) =>
  queryOptions({
    queryKey: decryptedKey(attachments, ref),
    enabled: ref !== undefined,
    // Kept, not decrypted again into a new URL while the old one lives on until the lock.
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      if (!ref) throw new Error('unreachable: disabled without a ref');
      const epoch = vaultStore.epoch();
      const bytes = await pageOperations.readAttachment(
        attachments.ctx,
        attachments.page,
        attachments.audience,
        ref,
      );
      return vaultStore.objectUrl(bytes, ref.mediaType, epoch);
    },
  });

/** A `blob:` URL for one of the page's attachments, decrypted here and kept until the vault locks. */
export const useDecrypted = (attachments: AttachmentContext, ref: AttachmentRef | undefined) =>
  useQuery(decryptedQuery(attachments, ref));

/** Drop a decrypted attachment nothing shows any more, revoking its URL now rather than at the lock. */
export function forgetDecrypted(
  queryClient: QueryClient,
  attachments: Pick<AttachmentContext, 'page' | 'audience'>,
  ref: AttachmentRef,
) {
  const queryKey = decryptedKey(attachments, ref);
  const url = queryClient.getQueryData<string>(queryKey);
  queryClient.removeQueries({ queryKey, exact: true });
  if (url) URL.revokeObjectURL(url);
}

/**
 * An image in a page body: one of its attachments, decrypted here, `width`
 * wide if the page's HTML says, or a note that it wasn't loaded.
 */
export function AttachmentImage({
  attachments,
  src,
  alt,
  width,
}: {
  attachments: AttachmentContext;
  src: string | undefined;
  alt: string | undefined;
  width?: React.ComponentProps<'img'>['width'];
}) {
  const id = attachmentId(src);
  const ref = attachments.attachments.find((a) => a.id === id);
  const { data: url } = useDecrypted(attachments, ref);
  if (!id || !ref) {
    // Remote images are never fetched: reading a page contacts no other host.
    return (
      <span className="inline-flex items-center gap-1.5 rounded-row bg-muted px-2 py-1 text-sm text-muted-foreground">
        <ImageOff className="size-4" strokeWidth={1.75} />
        {alt ? `Image not loaded: ${alt}` : 'Image not loaded'}
      </span>
    );
  }
  return url ? (
    <img src={url} alt={alt ?? ref.name} width={width} className="max-w-full rounded-control" />
  ) : (
    <span className="text-sm text-muted-foreground">Decrypting {ref.name}…</span>
  );
}

/** A download link to one of the page's attachments. */
export function AttachmentLink({
  attachments,
  id,
  children,
}: {
  attachments: AttachmentContext;
  id: string;
  children: React.ReactNode;
}) {
  const ref = attachments.attachments.find((a) => a.id === id);
  const { data: url } = useDecrypted(attachments, ref);
  if (!ref) return <span className="text-muted-foreground">{children}</span>;
  return (
    <a
      href={url}
      download={ref.name}
      className="inline-flex items-center gap-1 font-bold text-primary-ink"
    >
      <Paperclip className="size-4" strokeWidth={1.75} />
      <InLink value>{children}</InLink>
    </a>
  );
}
