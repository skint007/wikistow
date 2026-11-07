import { linkablePages, linkTableOf, RevisionId, type PagePayload } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useNotKept } from '../data/connection';
import { pageQuery, revisionQuery, treeQuery } from '../data/queries';
import { Markdown } from '../page/markdown';
import { useClient } from '../vault/store';
import type { PluginLocation } from './location';
import type { HeldDrawing, MarkdownDrawings, MarkdownPage } from './markdown-drawings';

/** What draws one plugin's Markdown for its page: the app's reader, or the workshop's. */
export type MarkdownReader = ComponentType<{ markdown: string; page: MarkdownPage }>;

/**
 * What plugins asked the app's reader to draw (`host.app.renderMarkdown`),
 * each in its plugin's element, drawn from here so it has the app's
 * router, queries and plugins around it. A plugin that can't read the
 * page gets a note instead.
 */
export function RenderedMarkdown({
  drawings,
  Reader,
}: {
  drawings: MarkdownDrawings;
  Reader: MarkdownReader;
}) {
  const held = useSyncExternalStore(drawings.subscribe, drawings.get);
  return held.map(({ box, key, ...drawing }) =>
    createPortal(<Readable {...drawing} Reader={Reader} />, box, String(key)),
  );
}

/** One drawing, once its plugin is found to read the page: the page is in its tree. */
function Readable({
  markdown,
  page,
  pages,
  Reader,
}: Omit<HeldDrawing, 'box' | 'key'> & { Reader: MarkdownReader }) {
  const [readable, setReadable] = useState<boolean | null>(null);
  const { spaceId, pageId } = page;
  useEffect(() => {
    let current = true;
    void pages
      .tree(spaceId)
      .then(
        (tree) => tree.some((entry) => entry.kind === 'page' && entry.pageId === pageId),
        () => false,
      )
      .then((can) => {
        if (current) setReadable(can);
      });
    return () => {
      current = false;
    };
  }, [pages, spaceId, pageId]);
  if (readable === null) return null;
  if (!readable) {
    return (
      <p role="note" className="text-sm text-muted-foreground">
        This plugin can’t read that page.
      </p>
    );
  }
  return <Reader markdown={markdown} page={page} />;
}

/**
 * The app's reader for a plugin's Markdown, as the page's own text is
 * drawn: with the files and links of the version `page` names, else the
 * version shown of it, else its latest publication, else its draft.
 * Wikilinks resolve among the space's pages; nothing offers to make a page.
 */
export function appReader(location: PluginLocation): MarkdownReader {
  return function PageMarkdown({ markdown, page }) {
    const ctx = useClient();
    const shown = location.shown();
    const { data: info, isPending } = useQuery({
      ...pageQuery(ctx, page.pageId),
      enabled: page.revision === undefined,
    });
    const shownRevision =
      shown?.page.pageId === page.pageId ? RevisionId.safeParse(shown.revision) : null;
    const named: Named | null =
      page.version && page.revision
        ? { audience: page.version, revision: page.revision }
        : shown && shownRevision?.success
          ? { audience: shown.version, revision: shownRevision.data }
          : info?.heads.publishedHead
            ? { audience: 'published', revision: info.heads.publishedHead }
            : info?.heads.draftHead
              ? { audience: 'draft', revision: info.heads.draftHead }
              : null;
    if (named) return <InVersion markdown={markdown} page={page} named={named} />;
    // A page with no version to read draws without files.
    if (page.revision === undefined && isPending) return null;
    return <PageText markdown={markdown} page={page} audience="published" payload={null} />;
  };
}

type Named = { audience: 'draft' | 'published'; revision: RevisionId };

/** `markdown` with the files and links of the version `named`, once that is read. */
function InVersion({
  markdown,
  page,
  named,
}: {
  markdown: string;
  page: MarkdownPage;
  named: Named;
}) {
  const ctx = useClient();
  const ref = { spaceId: page.spaceId, pageId: page.pageId };
  const { data: revision, isPending } = useQuery(
    revisionQuery(ctx, ref, named.audience, named.revision),
  );
  if (isPending) return null;
  // One that can't be read draws without its files.
  const payload = revision?.opened.kind === 'current' ? revision.opened.payload : null;
  return <PageText markdown={markdown} page={page} audience={named.audience} payload={payload} />;
}

/** The app's reader, for `page`, in the space's links. */
function PageText({
  markdown,
  page,
  audience,
  payload,
}: {
  markdown: string;
  page: MarkdownPage;
  audience: 'draft' | 'published';
  payload: PagePayload | null;
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, page.spaceId));
  const linkable = useMemo(() => (tree ? linkablePages(tree) : null), [tree]);
  const notKept = useNotKept(ctx, page.spaceId);
  return (
    <Markdown
      source={markdown}
      attachments={{
        ctx,
        page: { spaceId: page.spaceId, pageId: page.pageId },
        audience,
        attachments: payload?.attachments ?? [],
      }}
      pages={linkable}
      links={payload ? linkTableOf(payload) : NO_LINKS}
      notKept={notKept}
      editing={null}
    />
  );
}

const NO_LINKS: ReadonlyMap<string, string> = new Map();
