import { PageId, type FolderId, type SpaceId, type WikilinkNode } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { use, useState } from 'react';
import { runCommand } from '../commands/command';
import { createPage } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { searchIndexChanged, treeQuery } from '../data/queries';
import { linkHint } from '../desktop';
import { errorMessage } from '../errors';
import { AttachmentImage, AttachmentLink, ATTACHMENT_SCHEME } from './attachments';
import { InLink, PageBody, type PageBodyContext } from './body-context';
import { wikilinkView, type WikilinkView } from './wikilink-model';

/** One wikilink in a page body, resolved against what the viewer can open. */
export function WikilinkReader({ node }: { node: WikilinkNode }) {
  const body = use(PageBody);
  if (!body) throw new Error('unreachable: a page body provides it');
  const { attachments, pages, links, editing } = body;
  const view = wikilinkView(node, {
    pages,
    links,
    selfId: attachments.page.pageId,
    attachments: attachments.attachments,
    editor: editing !== null,
  });
  // In a link's text, a link to a page or a file, or one to create a page,
  // is part of that link (`InLink`), not a control of its own inside it.
  const inLink = use(InLink);
  switch (view.kind) {
    case 'page':
      if (inLink) return view.text;
      return <PageLink spaceId={attachments.page.spaceId} view={view} />;
    case 'image':
      return (
        <AttachmentImage
          attachments={attachments}
          src={`${ATTACHMENT_SCHEME}${view.attachmentId}`}
          alt={view.text}
        />
      );
    case 'file':
      if (inLink) return view.text;
      return (
        <AttachmentLink attachments={attachments} id={view.attachmentId}>
          {view.text}
        </AttachmentLink>
      );
    case 'missing':
      if (inLink || !editing?.create) return view.text;
      return <CreateLink body={body} parentId={editing.parentId} {...view} />;
    case 'ambiguous':
      // The chooser comes with the source editor; until then, just a hint.
      return (
        <span
          data-hint="More than one page has this title"
          aria-description="More than one page has this title"
          className="underline decoration-dotted underline-offset-2"
        >
          {view.text}
        </span>
      );
    case 'text':
      return view.text;
  }
}

/** A wikilink to a page of this wiki. */
function PageLink({
  spaceId,
  view: { pageId, hash, text, name },
}: {
  spaceId: SpaceId;
  view: Extract<WikilinkView, { kind: 'page' }>;
}) {
  const to = {
    to: '/s/$spaceId/p/$pageId',
    params: { spaceId, pageId: PageId.parse(pageId) },
    ...(hash ? { hash } : {}),
  } as const;
  return (
    <Link {...to} data-hint={linkHint(name)} className="text-primary underline">
      {text}
    </Link>
  );
}

// A link to a page nobody has made yet: the editor clicks it to create the
// page, in this page's folder, and goes on to its draft.
function CreateLink({
  body,
  parentId,
  title,
  text,
}: {
  body: PageBodyContext;
  parentId: FolderId | null;
  title: string;
  text: string;
}) {
  const { ctx, page } = body.attachments;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      await runCommand(
        createPage,
        { spaceId: page.spaceId, parentId, title },
        {
          ctx,
          satisfies: requirementsHere({ editor: true }),
          onCreated: async (pageId) => {
            searchIndexChanged(queryClient);
            await queryClient.invalidateQueries({
              queryKey: treeQuery(ctx, page.spaceId).queryKey,
            });
            await navigate({
              to: '/s/$spaceId/p/$pageId',
              params: { spaceId: page.spaceId, pageId },
              search: { view: 'draft' },
            });
          },
        },
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <>
      <button
        type="button"
        data-hint="Create this page"
        aria-description="Create this page"
        onClick={() => void create()}
        className="text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
      >
        {text}
      </button>
      {error && (
        <span role="alert" className="ml-1 text-sm text-destructive">
          {error}
        </span>
      )}
    </>
  );
}
