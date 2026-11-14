import {
  defaultValueCtx,
  editorViewCtx,
  EditorStatus,
  parserCtx,
  serializerCtx,
  type Editor,
} from '@milkdown/kit/core';
import type { Node, ResolvedPos } from '@milkdown/kit/prose/model';
import { Plugin, Selection, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import {
  use,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type { Found } from '../../find/match';
import type { EditorSurfaceProps } from '../surface';
import { LinkCompletion } from './completion';
import { CompletionListbox } from './completion-list';
import { alerts } from './alerts';
import { selectedMarkdown } from './at-cursor';
import { loadSyntaxNodes, visualEditor, visualPlugins } from './config';
import { planBlocks, replaceIn, replacement, same, type Taken } from './blocks';
import { BLOCK_TIMED, checkFidelity, endsInLine, fidelityOf, withLf } from './fidelity';
import { lineBreakFor } from '../surface';
import { inText, spansOf, type Span } from './sources';
import { visualFind, visualFindable } from './find';
import { visualPassages } from './passages';
import { formatKeys } from './formatting';
import { codeHighlights } from './highlight';
import { propertiesChanged, propertyReferences } from './property-references';
import { PluginsContext } from '../../../plugins/runtime';
import type { VisualHost } from './host';
import { QueryResults } from './query-results';
import { DiagramPreview } from '../../diagram';
import {
  changeRules,
  EXTERNAL,
  linkKeys,
  pasting,
  reportEdits,
  type Insert,
  unshownFootnotes,
} from './plugins';
import { FormatToolbar, FormatWatch } from './toolbar';
import { wrapSelection } from './wrapping';
import { Writer } from './writer';

export { checkFidelity, type Fidelity } from './fidelity';
export { wikilinkEditorNode } from './wikilink-node';

// Typing is reported at most this often, its first edit as soon as the
// page is idle, written and checked a block at a time in slices of idle
// time this long (`Writer`), so no keystroke waits on a long page. An edit
// made while a page just opened is still being read back is reported once
// it all is; one that must go out sooner, as the page is hidden or the
// editor left, writes and reads the whole page then.
const REPORT_MS = 150;
const SLICE_MS = 10;

// The idle period the last slice ran in.
let period: IdleDeadline | null = null;

/**
 * Run `work` once the page is idle, with whether it still has time for
 * another step as long as its last; returns a cancel. While the idle
 * period the last slice ran in lasts, it runs as a task of its own, after
 * any input waiting, not in the next period.
 */
function whenIdle(work: (more: () => boolean) => void): () => void {
  const slice = () => {
    let last = performance.now();
    const end = last + Math.min(SLICE_MS, period?.timeRemaining() || SLICE_MS);
    work(() => {
      const now = performance.now();
      const step = now - last;
      last = now;
      return now + step < end;
    });
  };
  if (typeof requestIdleCallback !== 'function' || (period?.timeRemaining() ?? 0) > 0) {
    const id = setTimeout(slice, 0);
    return () => clearTimeout(id);
  }
  const id = requestIdleCallback(
    (idle) => {
      period = idle;
      slice();
    },
    { timeout: REPORT_MS },
  );
  return () => cancelIdleCallback(id);
}

/**
 * `spans`, for `doc`'s top-level blocks by index, each only for a block
 * that shows as what was read there (`read`): one `was` had, which the
 * change left, or one the same. ProseMirror fitting the change in, or a
 * plugin after it, may have made it otherwise.
 */
function shownAsRead(
  doc: Node,
  was: Node | undefined,
  read: (i: number) => Node | undefined,
  spans: readonly (Span | null)[],
): (Span | null)[] {
  const kept = new Set(was?.content.content);
  return spans.map((span, i) => {
    const node = doc.maybeChild(i);
    const there = read(i);
    return span && node && (kept.has(node) || (!!there && same(node, there))) ? span : null;
  });
}

/**
 * `taken`, read from `markdown`, put in `view` in place of the blocks of
 * `doc` it replaces, changing only what reads differently; and what `write`
 * keeps as each block's source then.
 */
function putIn(view: EditorView, write: Writer, markdown: string, doc: Node, taken: Taken) {
  const { schema } = doc.type;
  const was = schema.topNodeType.create(
    null,
    doc.content.content.slice(taken.first, taken.first + taken.count),
  );
  const change = replacement(was, schema.topNodeType.create(null, taken.nodes));
  if (change) {
    let at = 0;
    for (let i = 0; i < taken.first; i++) at += doc.child(i).nodeSize;
    view.dispatch(
      replaceIn(view.state.tr, change, at).setMeta(EXTERNAL, true).setMeta('addToHistory', false),
    );
  }
  const now = view.state.doc;
  const { first, nodes } = taken;
  const read = (i: number) =>
    i >= first && i < first + nodes.length ? nodes[i - first] : undefined;
  if (taken.spans.length === now.childCount)
    write.source({ doc: now, text: markdown, spans: shownAsRead(now, doc, read, taken.spans) });
  else write.source(null);
  return now;
}

// Whether `tr` is the session's change (`EXTERNAL`), or one plugins added to it.
const external = (tr: Transaction) =>
  !!((tr.getMeta('appendedTransaction') as Transaction | undefined) ?? tr).getMeta(EXTERNAL);

// While `holding` says so, the document takes no change but the session's,
// nor a task's checkbox a click: the session's text goes in once it's done.
const held = (holding: () => boolean) =>
  $prose(
    () =>
      new Plugin({
        filterTransaction: (tr) => !tr.docChanged || external(tr) || !holding(),
        // Its own node view takes the checkbox's events, so they're caught on the way.
        view: (view) => {
          const click = (event: Event) => {
            if (holding() && event.target instanceof HTMLInputElement) event.preventDefault();
          };
          view.dom.addEventListener('click', click, true);
          return { destroy: () => view.dom.removeEventListener('click', click, true) };
        },
      }),
  );

export type VisualSurfaceProps = EditorSurfaceProps & {
  /**
   * The document it shows was written as Markdown that reads differently:
   * that text, which `read` gives and the page must show in source mode.
   */
  onUnfaithful?: (markdown: string) => void;
  /** Whether it takes no edit for now, as text it's to be given is checked. */
  holding?: () => boolean;
};

/**
 * The visual surface: Milkdown over the page body, for bodies the fidelity
 * check (`checkFidelity`) passed. A document unchanged from the text it was
 * given gives that text back byte for byte; once edited, it's written as
 * Markdown again, in the page's line breaks. Milkdown only sees LF. Each
 * such writing is read back (`Writer`), and one that doesn't read as the
 * document it shows goes to `onUnfaithful` as well as out: it's what the
 * page then holds, shown in source mode, so what's saved is what's shown.
 */
export default function VisualSurface(props: VisualSurfaceProps) {
  return (
    <MilkdownProvider>
      <Surface {...props} />
    </MilkdownProvider>
  );
}

const noQueries = new QueryResults();

function Surface({
  initial,
  onChange,
  onEditing,
  links,
  attachments,
  onFiles,
  lineBreak,
  onUnfaithful,
  holding,
  page,
  properties,
  setProperty,
  otherPages,
  queryTable,
  toolbar,
  ref,
}: VisualSurfaceProps) {
  const nodes = use(loadSyntaxNodes());
  // The editor is built once; it reads the latest of these when it needs them.
  const latest = useRef({
    onChange,
    onEditing,
    links,
    attachments,
    onFiles,
    lineBreak,
    onUnfaithful,
    holding,
    page,
    properties,
    setProperty,
    otherPages,
  });
  useLayoutEffect(() => {
    latest.current = {
      onChange,
      onEditing,
      links,
      attachments,
      onFiles,
      lineBreak,
      onUnfaithful,
      holding,
      page,
      properties,
      setProperty,
      otherPages,
    };
  });
  // The runtime of the place it is drawn in, if any, for the editor's whole life.
  const plugins = use(PluginsContext);
  const [host] = useState<VisualHost>(() => ({
    links: () => latest.current.links,
    attachments: () => latest.current.attachments,
    live: new Set(),
    page: () => latest.current.page ?? null,
    plugins: () => plugins,
    queries: new QueryResults(),
    diagrams: new QueryResults(),
    properties: () => latest.current.properties ?? null,
    setProperty: () => latest.current.setProperty ?? null,
    propertyViews: new Set(),
  }));
  // References show the values the frontmatter, and the index for other pages', have now,
  // and plugin blocks the properties.
  useEffect(() => {
    editor.current?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(propertiesChanged(view.state.tr));
    });
    for (const view of host.propertyViews) view.propertiesChanged();
  }, [properties, otherPages, host]);
  // Each query block's result, drawn under its code where the editor put a place for it.
  const queries = useSyncExternalStore(
    host.queries?.subscribe ?? noQueries.subscribe,
    host.queries?.list ?? noQueries.list,
  );
  // And each diagram, under its code.
  const diagrams = useSyncExternalStore(
    host.diagrams?.subscribe ?? noQueries.subscribe,
    host.diagrams?.list ?? noQueries.list,
  );
  const text = useRef(initial);
  // The editor once it's made, its writer, and the text it was last given,
  // with the document it made of it: an unchanged document gives it back.
  const editor = useRef<Editor | null>(null);
  const writer = useRef<Writer | null>(null);
  // How a plugin's Markdown goes in at the cursor, once the editor's made (`pasting`).
  const inserting = useRef<Insert | null>(null);
  const origin = useRef<{ markdown: string; doc: Node } | null>(null);
  // Work waiting for idle time, whether an edit is yet to be reported, and
  // when the last was.
  const waiting = useRef<(() => void) | null>(null);
  const edited = useRef(false);
  const reported = useRef(-Infinity);
  // The last document given to `onUnfaithful`, which is told once of each.
  const told = useRef<Node | null>(null);
  // Focus asked for before the editor was made.
  const focusing = useRef<{ at: number | undefined } | null>(null);
  // Strict Mode makes the editor twice; the last made is the one kept.
  const made = useRef(0);
  // Each text shown, a block at a time or whole, counted, so one checked
  // meanwhile doesn't go in over a later one.
  const changes = useRef(0);

  const docOf = (live: Editor) => live.action((ctx) => ctx.get(editorViewCtx).state.doc);
  // `doc` as the page holds it, ending as the text it was given does, and
  // whether it reads as it shows. Before the page is all read back, the
  // rest is read back now.
  const writing = (write: Writer, doc: Node, given: string) => {
    const final = endsInLine(given);
    write.breaks(lineBreakFor(given, latest.current.lineBreak));
    return { ...write.write(doc, final), page: write.page(doc, final) };
  };
  /**
   * `doc`, read from `markdown` by the editor's parser, or one that shows
   * the same, as a document a change from it made: each top-level block's
   * source is where `read`'s was, for the writer to keep (`Writer.source`).
   */
  const sourceAs = (write: Writer, doc: Node, markdown: string, read: Node, was?: Node) => {
    const spans = spansOf(read);
    if (!spans || spans.length !== doc.childCount) return write.source(null);
    const kept = shownAsRead(doc, was, (i) => read.maybeChild(i) ?? undefined, spans);
    write.source({ doc, text: markdown, spans: inText(markdown, kept) });
  };
  const [surface] = useState(() => ({
    read: (): string => {
      const live = editor.current;
      const given = origin.current;
      const write = writer.current;
      if (!live || !given || !write) return text.current;
      const doc = docOf(live);
      if (doc.eq(given.doc)) return (text.current = given.markdown);
      const now = writing(write, doc, given.markdown);
      // Written as it was given, as an edit undone by retyping it is.
      const was = writing(write, given.doc, given.markdown);
      if (now.page === was.page) return (text.current = given.markdown);
      text.current = now.page;
      if (!now.faithful && told.current !== doc) {
        told.current = doc;
        const page = text.current;
        queueMicrotask(() => latest.current.onUnfaithful?.(page));
      }
      return text.current;
    },
    /** Where the cursor is in `read`'s text, or null if that can't be told. */
    caret: (): number | null => {
      const live = editor.current;
      const write = writer.current;
      const given = origin.current;
      if (!live || !write || !given) return null;
      const markdown = surface.read();
      const { doc, selection } = live.action((ctx) => ctx.get(editorViewCtx).state);
      const at = write.caret(doc, selection.head, endsInLine(given.markdown));
      return at === null ? null : Math.min(at, markdown.length);
    },
    report: () => {
      edited.current = false;
      reported.current = performance.now();
      latest.current.onChange(surface.read());
    },
    /**
     * Write and check the document in idle time, a slice at a time,
     * reporting an edit once that's done, at most every `REPORT_MS`.
     */
    later: () => {
      if (waiting.current) return;
      waiting.current = whenIdle((more) => {
        waiting.current = null;
        const live = editor.current;
        const write = writer.current;
        if (!live || !write) return;
        if (!write.prepare(docOf(live), more)) return surface.later();
        if (!edited.current) return;
        const wait = reported.current + REPORT_MS - performance.now();
        if (wait <= 0) return surface.report();
        const timer = setTimeout(() => {
          waiting.current = null;
          surface.later();
        }, wait);
        waiting.current = () => clearTimeout(timer);
      });
    },
    /** Report an edit not yet reported now, as when the page is hidden or left. */
    flush: () => {
      if (!edited.current) return;
      waiting.current?.();
      waiting.current = null;
      surface.report();
    },
    /**
     * Show `markdown`, read whole, changing only what differs so the cursor
     * stays where it was.
     */
    show: (markdown: string) => {
      changes.current++;
      text.current = markdown;
      // A cursor asked for before it was made was in other text.
      focusing.current = null;
      editor.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const next = ctx.get(parserCtx)(withLf(markdown));
        const { doc } = view.state;
        const change = replacement(doc, next);
        if (change)
          view.dispatch(
            replaceIn(view.state.tr, change).setMeta(EXTERNAL, true).setMeta('addToHistory', false),
          );
        origin.current = { markdown, doc: view.state.doc };
        if (writer.current) sourceAs(writer.current, view.state.doc, markdown, next, doc);
      });
      surface.later();
    },
    /**
     * Show `markdown` by reading again only the top-level blocks it changes,
     * with those beside them (`planBlocks`), checked as a paste is: at once
     * if that's under 1 KB (`BLOCK_TIMED`), else in the check's worker,
     * going in once it's checked, if nothing has gone in meanwhile, or
     * with `atOnce`, not at all. False, and nothing shown, if it must be
     * read whole (`show`), checked first as a page is. The cursor stays where it was, and the change is no
     * edit to undo.
     */
    take: (markdown: string, atOnce = false): boolean | Promise<boolean> => {
      const live = editor.current;
      const write = writer.current;
      const given = origin.current;
      if (!live || !write || !given) return false;
      const holds = surface.read();
      const mine = ++changes.current;
      const plan = live.action((ctx) => {
        const { doc } = ctx.get(editorViewCtx).state;
        const { page, runs, spans } = write.layout(doc, endsInLine(given.markdown));
        // Only text it holds as the page does can be compared with it.
        if (page !== holds) return null;
        const parse = ctx.get(parserCtx);
        const made = planBlocks({ doc, page, runs, spans, text: markdown, parse });
        const transform = { parse, serialize: ctx.get(serializerCtx) };
        return made && { ...made, doc, transform };
      });
      if (!plan) return false;
      const go = (kept: boolean) => {
        const now = editor.current;
        if (!kept || !now || mine !== changes.current || docOf(now) !== plan.doc) return false;
        const taken = plan.finish();
        if (!taken) return false;
        const doc = now.action((ctx) =>
          putIn(ctx.get(editorViewCtx), write, markdown, plan.doc, taken),
        );
        text.current = markdown;
        focusing.current = null;
        origin.current = { markdown, doc };
        surface.later();
        return true;
      };
      if (plan.check.length < BLOCK_TIMED) return go(fidelityOf(plan.check, plan.transform).visual);
      if (atOnce) return false;
      // Anything that fails on the way, as a plugin putting it in, is as
      // if it couldn't be taken in so.
      return checkFidelity(plan.check)
        .then((fidelity) => go(fidelity.visual))
        .catch(() => false);
    },
    /**
     * Show `markdown`, checked already, at once: a block at a time if that
     * can be checked at once, else read whole.
     */
    replace: (markdown: string) => {
      if (surface.take(markdown, true) !== true) surface.show(markdown);
    },
    edit: () => {
      edited.current = true;
      latest.current.onEditing?.();
      surface.later();
    },
    /**
     * Focus it, the cursor at the document's end for `at` at the text's,
     * as after a paste into an empty page; once it's made, if it isn't yet
     * and nothing else has the focus then.
     */
    focus: (at?: number) => {
      const live = editor.current;
      if (!live) return void (focusing.current = { at });
      focusing.current = null;
      live.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (at !== undefined && at >= surface.read().length)
          view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
        view.focus();
      });
    },
    /**
     * Put `code` as inline code in place of the text selected; with a
     * node, cells or everything selected, at the nearest cursor after it.
     */
    insertCode: (code: string) => {
      editor.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const mark = state.schema.marks['inlineCode'];
        if (!mark) return;
        const tr = state.tr;
        if (!(state.selection instanceof TextSelection)) {
          tr.setSelection(Selection.near(state.doc.resolve(state.selection.to)));
          // A page with no text anywhere to put it in.
          if (!(tr.selection instanceof TextSelection)) return;
        }
        // In a code block, marks don't hold: the code is text there.
        const inCode = !!tr.selection.$from.parent.type.spec.code;
        const marked = (node: Node | null | undefined) =>
          !inCode && !!node && mark.isInSet(node.marks);
        // Where the code span `$at` is strictly inside ends, if it is in one.
        const spanEnd = ($at: ResolvedPos) => {
          if (!marked($at.nodeBefore) || !marked($at.nodeAfter)) return null;
          let end = $at.parentOffset;
          let offset = 0;
          for (let i = 0; i < $at.parent.childCount; i++) {
            const child = $at.parent.child(i);
            const childEnd = offset + child.nodeSize;
            if (childEnd > $at.parentOffset) {
              if (!marked(child)) break;
              end = childEnd;
            }
            offset = childEnd;
          }
          return $at.start() + end;
        };
        // A cursor or a selection end in a code span puts it after the span,
        // replacing nothing, so no span is cut.
        const { $from: $start, $to: $end } = tr.selection;
        const after = spanEnd($end) ?? $end.pos;
        if (after !== $end.pos || (!tr.selection.empty && spanEnd($start) !== null)) {
          tr.setSelection(TextSelection.create(tr.doc, after));
        }
        // Code beside it would join it into one span: a space keeps them apart.
        const { from, to, $from, $to } = tr.selection;
        const nodes = [
          ...(marked($from.nodeBefore) ? [state.schema.text(' ')] : []),
          state.schema.text(code, inCode ? [] : [mark.create()]),
          ...(marked($to.nodeAfter) ? [state.schema.text(' ')] : []),
        ];
        tr.replaceWith(from, to, nodes);
        const size = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
        tr.setSelection(TextSelection.create(tr.doc, from + size));
        // Typing after it isn't code.
        view.dispatch(tr.removeStoredMark(mark).scrollIntoView());
        view.focus();
      });
    },
    selection: (): string => {
      const live = editor.current;
      const write = writer.current;
      if (!live || !write) return '';
      return selectedMarkdown(
        live.action((ctx) => ctx.get(editorViewCtx).state),
        write,
      );
    },
    insert: (markdown: string) => inserting.current?.(markdown),
  }));
  const [completion] = useState(
    () =>
      new LinkCompletion(
        () => latest.current.links,
        () => surface.read(),
        () => latest.current.properties ?? null,
        () => latest.current.otherPages ?? null,
      ),
  );
  const [format] = useState(() => new FormatWatch());
  // Who hears what Find on page finds, while it searches here.
  const findReport = useRef<((found: Found) => void) | null>(null);
  const [findable] = useState(() =>
    visualFindable(
      () => {
        // None once it's going, as the page closes with the bar open.
        const view = editor.current?.action((ctx) => ctx.get(editorViewCtx));
        return view && !view.isDestroyed ? view : null;
      },
      (report) => (findReport.current = report),
    ),
  );

  const [passages] = useState(() =>
    visualPassages(() => {
      const view = editor.current?.action((ctx) => ctx.get(editorViewCtx));
      return view && !view.isDestroyed ? view : null;
    }),
  );

  useEditor((root) => {
    const generation = ++made.current;
    const given = text.current;
    const next = visualEditor({
      root,
      plugins: [
        // Its arrow keys, while its list is open, before any other's.
        completion.plugin,
        ...visualPlugins(host, nodes),
        held(() => latest.current.holding?.() ?? false),
        reportEdits(surface.edit),
        pasting(
          () => latest.current.onFiles,
          () => writer.current,
          format.uploads,
          (insert, live) => {
            // Strict Mode's first editor goes after the second is made.
            if (live) inserting.current = insert;
            else if (inserting.current === insert) inserting.current = null;
          },
        ),
        ...changeRules,
        unshownFootnotes,
        codeHighlights,
        propertyReferences(
          () => latest.current.properties ?? null,
          () => latest.current.otherPages ?? null,
        ),
        alerts,
        linkKeys(host),
        format.plugin,
        formatKeys,
        wrapSelection,
        visualFind(() => findReport.current),
      ].flat(),
      view: {
        attributes: {
          id: 'page-visual',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Page',
          spellcheck: 'true',
          class: 'page-body min-h-full px-4 py-3 outline-none',
        },
      },
    }).config((ctx) => ctx.set(defaultValueCtx, withLf(given)));
    next.onStatusChange((status) => {
      if (status === EditorStatus.Created && generation === made.current) {
        editor.current = next;
        const write = next.action(
          (ctx) => new Writer({ parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) }),
        );
        writer.current = write;
        const doc = docOf(next);
        origin.current = { markdown: given, doc };
        // Where each block was read from, as Milkdown read the page (`readingSpans`).
        sourceAs(write, doc, given, doc);
        // Text the session showed while it was being made, which reading it
        // as it is would replace.
        const shown = text.current;
        if (shown !== given) surface.replace(shown);
        // Ready for the first edit, written meanwhile.
        else surface.later();
        // Focus asked for meanwhile, unless the person went elsewhere.
        const free = !document.activeElement || document.activeElement === document.body;
        if (focusing.current && free) surface.focus(focusing.current.at);
        focusing.current = null;
      } else if (status === EditorStatus.OnDestroy && editor.current === next) {
        editor.current = null;
      }
    });
    return next;
  }, []);

  // Its last edit goes out when the page is hidden, as the tab may then be
  // closed, as the source editor's goes out as it's typed.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') surface.flush();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', surface.flush);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', surface.flush);
    };
  }, [surface]);

  // Its last edit goes out before it's gone, however soon after it, written
  // now. Layout effects end before the editor's own, so it's still there.
  useLayoutEffect(
    () => () => {
      waiting.current?.();
      waiting.current = null;
      if (edited.current) surface.report();
    },
    [surface],
  );

  // Pages, the link table and attachments change as the tree loads and saves land.
  useEffect(() => {
    for (const view of host.live) view.redraw();
    completion.refresh();
  }, [host, completion, links, attachments]);

  useImperativeHandle(
    ref,
    () => ({
      findable,
      passages,
      read: surface.read,
      replace: surface.replace,
      take: (markdown: string) => surface.take(markdown),
      caret: surface.caret,
      focus: surface.focus,
      insertCode: surface.insertCode,
      selection: surface.selection,
      insert: surface.insert,
    }),
    [surface, findable, passages],
  );

  // It fills the box the page editor gives it, the toolbar along its top
  // and the text scrolling below. The editable body is at least as tall as
  // what's left, so a click below the text lands in it.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-control border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <FormatToolbar
        watch={format}
        attachments={attachments.listed ?? attachments.list}
        plugins={toolbar}
      />
      <div className="min-h-0 flex-1 overflow-y-auto [&_.milkdown]:h-full [&>[data-milkdown-root]]:h-full">
        <Milkdown />
        <CompletionListbox completion={completion} />
        {queryTable &&
          queries.map(({ key, element, source }) =>
            createPortal(queryTable(source), element, String(key)),
          )}
        {diagrams.map(({ key, element, source }) =>
          createPortal(<DiagramPreview source={source} />, element, String(key)),
        )}
      </div>
    </div>
  );
}
