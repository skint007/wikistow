import type { LinkablePage, PageId, SpaceId } from '@wikistow/client';
import { readComment } from '@wikistow/client/reader';
import { Link } from '@tanstack/react-router';
import type { Nodes, Root, RootContent } from 'mdast';
import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import { linkHint } from '../desktop';
import { BodyLink } from '../page/body-link';
import { wikilinkView } from '../page/wikilink-model';

// The app's own address of a page, which a wikilink becomes.
const IN_APP = /^\/s\/[^/]+\/p\/[^/#]+(?:#.*)?$/;

/**
 * The tree with wikilinks made links to the pages they name in the
 * viewer's own tree, by title, since a comment has no link table, or their
 * text; raw HTML made the text it is.
 */
function resolved(
  tree: Root,
  scope: { spaceId: SpaceId; pageId: PageId; pages: readonly LinkablePage[] | null },
): Root {
  const map = (node: RootContent): RootContent => {
    if (node.type === 'html') return { type: 'text', value: node.value };
    if (node.type === 'wikilink') {
      const view = wikilinkView(node, {
        pages: scope.pages,
        links: new Map(),
        selfId: scope.pageId,
        attachments: [],
        editor: false,
      });
      if (view.kind !== 'page') return { type: 'text', value: view.text };
      const hash = view.hash ? `#${view.hash}` : '';
      return {
        type: 'link',
        url: `/s/${view.spaceId ?? scope.spaceId}/p/${view.pageId}${hash}`,
        title: view.name,
        children: [{ type: 'text', value: view.text }],
      };
    }
    if ('children' in node) {
      const parent: Nodes = node;
      return { ...parent, children: parent.children.map(map) } as RootContent;
    }
    return node;
  };
  return { ...tree, children: tree.children.map(map) };
}

// A remark plugin: the tree read above, in place of the empty one parsed here.
const readTree = (tree: Root) => () => tree;

const components: Components = {
  // Nothing in a comment loads: an image shows as its words.
  img: ({ alt }) => <span className="text-muted-foreground">[{alt || 'image'}]</span>,
  a: ({ href, title, children }) => {
    if (!href) return <span>{children}</span>;
    if (IN_APP.test(href)) {
      return (
        <Link to={href} {...linkHint(title ?? href)} className="text-primary underline">
          {children}
        </Link>
      );
    }
    return <BodyLink href={href}>{children}</BodyLink>;
  },
};

/**
 * A comment's text (ADR 0014, decision 4): Markdown read as the reader
 * reads a page, without raw HTML, images, embeds, plugin blocks, query
 * tables or diagrams. Task boxes are drawn but never live; property
 * references and claimed inline code are the plain code they are. Links
 * work, and a wikilink resolves by title among the pages the viewer can
 * open (`pages`).
 */
export function CommentText({
  text,
  spaceId,
  pageId,
  pages,
}: {
  text: string;
  spaceId: SpaceId;
  pageId: PageId;
  pages: readonly LinkablePage[] | null;
}) {
  const tree = useMemo(
    () => resolved(readComment(text), { spaceId, pageId, pages }),
    [text, spaceId, pageId, pages],
  );
  return (
    <div className="comment-text grid gap-2 text-sm break-words [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_li]:ms-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-control [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[[readTree, tree]]}
        urlTransform={defaultUrlTransform}
        components={components}
      />
    </div>
  );
}
