import {
  mayReferOtherPages,
  parsePropertyReference,
  readProperties,
  splitFrontmatter,
} from '@wikistow/client';
import { pageHtml, SYNTAX } from '@wikistow/client/reader';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import type { InlineCode, Root, RootContent } from 'mdast';
import {
  Component,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown';
import { claimedBlock } from '@wikistow/plugin-sdk';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReaderBlock, textOf } from '../plugins/blocks';
import { usePlugins } from '../plugins/runtime';
import { markdownSyntaxes } from '../registries';
import { PLAIN } from '../vault/store';
import { AlertTitle, alertClass } from './alert-title';
import {
  ATTACHMENT_SCHEME,
  AttachmentImage,
  AttachmentLink,
  attachmentId,
  type AttachmentContext,
} from './attachments';
import { usePageIndex } from '../data/page-index';
import { OtherPagesContext, PageBody, PageProperties, type PageBodyContext } from './body-context';
import { BodyLink } from './body-link';
import { MarkdownTimeout, READ_BUDGET_MS } from './markdown-worker';
import { otherPages } from './other-pages';
import { pageReader } from './page-reader';
import { PropertiesBox } from './properties-box';
import { PropertyReferenceView } from './property-reference';
import { bodyLinkScope } from './property-value';

export { ATTACHMENT_SCHEME, type AttachmentContext };

/** The safe-URL filter, letting attachment references through to be resolved locally. */
const urlTransform = (url: string) =>
  url.startsWith(ATTACHMENT_SCHEME) ? url : defaultUrlTransform(url);

type Handlers = NonNullable<NonNullable<Options['remarkRehypeOptions']>['handlers']>;

/**
 * Each registered syntax's nodes become an empty span, marked (`SYNTAX`)
 * with where `held` keeps what its Reader renders, which the `span`
 * component puts in its place. Only a mark gets through the page's HTML
 * being parsed again and sanitized (`pageHtml`), which keep no node's data.
 */
const syntaxHandlers = (held: ReactElement[]): Handlers =>
  Object.fromEntries(
    markdownSyntaxes.map(({ type, render }) => {
      const handler: NonNullable<Handlers[keyof Handlers]> = (_state, node: RootContent) => {
        const syntax = render(node);
        if (!syntax) return undefined;
        held.push(syntax);
        const properties = { [SYNTAX]: held.length - 1 };
        return { type: 'element', tagName: 'span', properties, children: [] };
      };
      return [type, handler];
    }),
  );

/**
 * Inline code that is a reference to a value (`` `=servings` ``,
 * `` `=[[Page]].key` ``) becomes a marked span, as a syntax does, which the
 * `span` component draws as `PropertyReferenceView`; other code is code.
 */
const referenceHandler =
  (held: ReactElement[]): NonNullable<Handlers[keyof Handlers]> =>
  (state, node: InlineCode) => {
    const reference = parsePropertyReference(node.value);
    if (reference) {
      held.push(
        <PropertyReferenceView name={reference.name} page={reference.page} source={node.value} />,
      );
      return {
        type: 'element',
        tagName: 'span',
        properties: { [SYNTAX]: held.length - 1 },
        children: [],
      };
    }
    // As mdast-util-to-hast writes it.
    const text = { type: 'text' as const, value: node.value.replace(/\r?\n|\r/g, ' ') };
    state.patch(node, text);
    const code = { type: 'element' as const, tagName: 'code', properties: {}, children: [text] };
    state.patch(node, code);
    return state.applyData(node, code);
  };

// The components below hold page content, plugin blocks among them, so each
// is the same on every render: a new one would draw everything in it afresh.

/** An alert (`remarkAlerts`) starts with its label. */
const Division: NonNullable<Components['div']> = ({ node: _node, children, ...props }) => {
  const type = alertClass(props.className);
  return (
    <div {...props}>
      {type && (
        <p className="markdown-alert-title">
          <AlertTitle type={type} />
        </p>
      )}
      {children}
    </div>
  );
};

/** A table wider than the page scrolls on its own, not the page with it. */
const Table: NonNullable<Components['table']> = ({ node: _node, ...props }) => (
  <div className="overflow-x-auto rounded-control">
    <table {...props} />
  </div>
);

/**
 * A code block under its language as written, or `text` for none, as the
 * visual editor shows it; or the view of a running plugin that claims it,
 * which keeps what a reader entered in it while the page around it changes.
 * Only the reader's label has a button that copies the code.
 */
const CodeBlock: NonNullable<Components['pre']> = ({ node, ...props }) => {
  const { blocks } = usePlugins();
  const body = use(PageBody);
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
  if (code?.type !== 'element') return <pre {...props} />;
  const { className } = code.properties;
  const language = Array.isArray(className)
    ? className
        .map(String)
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length)
    : undefined;
  // A fence a running plugin claims is its view; without the plugin, its text.
  const block = language ? blocks.get(language) : undefined;
  if (block && body) {
    return <ReaderBlock block={block} source={textOf(code)} page={body.attachments.page} />;
  }
  const claimed = language ? claimedBlock(language) : null;
  return (
    <div className="code-block">
      {/* The visual editor's label shares the class, without the button. */}
      <div className="code-language flex items-center gap-2 pt-1 pr-1">
        <span className="min-w-0 flex-1">
          {language || 'text'}
          {claimed && ` · shown as written, without the ${claimed.pluginId} plugin`}
        </span>
        <CopyCode text={textOf(code)} />
      </div>
      <pre {...props} />
    </div>
  );
};

/** Copies a code block's text, as written, showing a check for a moment once it's copied. */
function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={copied ? 'Copied' : 'Copy code'}
      data-hint="Copy code"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
    </Button>
  );
}

/** A remark plugin: the tree the worker read, in place of the empty one parsed here. */
const readTree = (tree: Root) => () => tree;

/**
 * A body as the worker reads it (`markdownJobs.body`), kept a few minutes
 * once nothing shows it (the default `gcTime`), so going back to a page
 * shows it at once, and dropped with the decrypted queries when the vault
 * locks. A read nothing waits for any more is ended with its worker. It
 * needs no network, and isn't tried again until the page is opened again.
 */
const readQuery = (body: string) =>
  queryOptions({
    queryKey: [PLAIN, 'markdown', body],
    queryFn: ({ signal }) => pageReader.run('body', body, { budgetMs: READ_BUDGET_MS, signal }),
    staleTime: 'static',
    networkMode: 'always',
    retry: false,
  });

const UNREADABLE = 'This page couldn’t be shown formatted, so here it is as written.';
const TOO_SLOW = 'This page took too long to format, so here it is as written.';

/**
 * A page body: GitHub-flavoured Markdown, the HTML in it (`pageHtml`) and
 * the registered syntaxes, with nothing that can run or reach out.
 * Frontmatter is shown above it as property rows (`PropertiesBox`).
 * The body is read in a worker, off the page's thread (`READ_BUDGET_MS`),
 * and only turned into HTML here.
 */
export function Markdown({ source, ...context }: { source: string } & PageBodyContext) {
  const { frontmatter, body } = splitFrontmatter(source);
  const properties = useMemo(() => {
    const read = readProperties(frontmatter);
    return read.ok ? read.properties : null;
  }, [frontmatter]);
  const { attachments, pages, links } = context;
  const editor = context.editing !== null;
  // Other pages' values come from the viewer's index, built only for a body that shows some.
  const { index } = usePageIndex(attachments.ctx, {
    enabled: pages !== null && mayReferOtherPages(body),
  });
  const others = useMemo(
    () =>
      otherPages(
        index,
        {
          spaceId: attachments.page.spaceId,
          selfId: attachments.page.pageId,
          pages,
          links,
          editor,
        },
        properties,
      ),
    [index, attachments.page.spaceId, attachments.page.pageId, pages, links, editor, properties],
  );
  const read = useQuery(readQuery(body));
  const hash = useLocation({ select: (location) => location.hash });
  // A link to a heading of this page arrives before its body is read.
  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, [hash, body, read.status]);
  const held: ReactElement[] = [];
  const components: Components = {
    span: ({ node, ...props }) => {
      const at = node?.properties[SYNTAX];
      return (at !== undefined && held[Number(at)]) || <span {...props} />;
    },
    div: Division,
    pre: CodeBlock,
    table: Table,
    img: ({ src, alt, width }) => (
      <AttachmentImage
        attachments={attachments}
        src={typeof src === 'string' ? src : undefined}
        alt={alt}
        width={width}
      />
    ),
    a: ({ href, id: anchor, children }) => {
      const id = attachmentId(href);
      if (id)
        return (
          <AttachmentLink attachments={attachments} id={id}>
            {children}
          </AttachmentLink>
        );
      // An anchor in the page's HTML (`<a id="setup">`) keeps its id.
      if (!href) return <span id={anchor}>{children}</span>;
      return <BodyLink href={href}>{children}</BodyLink>;
    },
  };
  return (
    <PageBody value={context}>
      <PageProperties value={properties}>
        <OtherPagesContext value={others}>
          {frontmatter !== null && (
            <PropertiesBox frontmatter={frontmatter} scope={bodyLinkScope(context)} />
          )}
          {read.isPending ? (
            <StillReading />
          ) : read.isSuccess ? (
            <AsWritten source={body}>
              <div className="page-body">
                <ReactMarkdown
                  remarkPlugins={[[readTree, read.data]]}
                  remarkRehypeOptions={{
                    handlers: { ...syntaxHandlers(held), inlineCode: referenceHandler(held) },
                  }}
                  rehypePlugins={[pageHtml]}
                  urlTransform={urlTransform}
                  components={components}
                />
              </div>
            </AsWritten>
          ) : (
            <Written
              source={body}
              note={read.error instanceof MarkdownTimeout ? TOO_SLOW : UNREADABLE}
            />
          )}
        </OtherPagesContext>
      </PageProperties>
    </PageBody>
  );
}

/** While a body is read: nothing at first, so a quick read doesn't flash, then a note. */
function StillReading() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 500);
    return () => clearTimeout(timer);
  }, []);
  return (
    shown && (
      <p role="status" className="text-sm text-muted-foreground">
        Formatting this page…
      </p>
    )
  );
}

/** A body shown as written, with `note` saying why. */
function Written({ source, note }: { source: string; note: string }) {
  return (
    <>
      <p role="note" className="rounded-control bg-muted p-3 text-sm">
        {note}
      </p>
      <pre className="mt-4 text-sm whitespace-pre-wrap wrap-anywhere">{source}</pre>
    </>
  );
}

/**
 * A body that can't be rendered (nested thousands deep, say, past the
 * stack of what turns it into HTML) is shown as written, with a note,
 * instead of failing the whole page. Another source is tried afresh.
 */
class AsWritten extends Component<
  { source: string; children: ReactNode },
  { source: string; failed: boolean }
> {
  override state = { source: this.props.source, failed: false };

  static getDerivedStateFromProps(
    { source }: { source: string },
    state: { source: string },
  ): { source: string; failed: boolean } | null {
    return source === state.source ? null : { source, failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <Written source={this.props.source} note={UNREADABLE} />;
  }
}
