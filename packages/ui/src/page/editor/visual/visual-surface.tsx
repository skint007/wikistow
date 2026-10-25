import {
  defaultValueCtx,
  editorViewCtx,
  EditorStatus,
  parserCtx,
  serializerCtx,
  type Editor,
} from '@milkdown/kit/core';
import type { Node, ResolvedPos, Slice } from '@milkdown/kit/prose/model';
import { Plugin, Selection, TextSelection } from '@milkdown/kit/prose/state';
import { Transform } from '@milkdown/kit/prose/transform';
import { $prose } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { use, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { EditorSurfaceProps } from '../surface';
import { LinkCompletion } from './completion';
import { CompletionListbox } from './completion-list';
import { alerts } from './alerts';
import { loadSyntaxNodes, visualEditor, visualPlugins } from './config';
import { endsInLine, inLineBreaks, withLf } from './fidelity';
import { formatKeys } from './formatting';
import { codeHighlights } from './highlight';
import { usePluginRuntime } from '../../../plugins/runtime';
import type { VisualHost } from './host';
import {
  cellLinks,
  EXTERNAL,
  autolinks,
  footnotes,
  htmlBlocks,
  linkKeys,
  pasting,
  reportEdits,
  tableHeaders,
  typedLinks,
  unshownFootnotes,
} from './plugins';
import { FormatToolbar, FormatWatch } from './toolbar';
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

// `doc` with no link's `id`, which each reading gives anew: two readings
// of the same text are then the same.
function unnumbered(doc: Node): Node {
  const type = doc.type.schema.marks['link'];
  if (!type) return doc;
  const tr = new Transform(doc);
  doc.descendants((node, pos) => {
    const link = type.isInSet(node.marks);
    if (link && link.attrs['id'] !== null)
      tr.addMark(pos, pos + node.nodeSize, type.create({ ...link.attrs, id: null }));
  });
  return tr.doc;
}

const linkOf = (node: Node | null | undefined) =>
  node?.marks.find((mark) => mark.type.name === 'link');

// `next` from `start` to `b`, to stand for `doc` from `start` to `a`, with
// each link running on past either end given the id it has there in `doc`,
// so text changed inside a link leaves it one.
function inPlace(doc: Node, next: Node, start: number, a: number, b: number): Slice {
  const ids = new Map<unknown, unknown>();
  for (const [kept, read] of [
    [doc.resolve(start).nodeBefore, next.resolve(start).nodeBefore],
    [doc.resolve(a).nodeAfter, next.resolve(b).nodeAfter],
  ]) {
    const [mine, theirs] = [linkOf(kept), linkOf(read)];
    if (mine && theirs) ids.set(theirs.attrs['id'], mine.attrs['id']);
  }
  const tr = new Transform(next);
  next.nodesBetween(start, b, (node, pos) => {
    const link = linkOf(node);
    const id = link && ids.get(link.attrs['id']);
    if (!link || id === undefined) return;
    const [from, to] = [Math.max(pos, start), Math.min(pos + node.nodeSize, b)];
    tr.addMark(from, to, link.type.create({ ...link.attrs, id }));
  });
  return tr.doc.slice(start, b);
}

// While `holding` says so, the document takes no change, nor a task's
// checkbox a click: the session's text goes in once it's done.
const held = (holding: () => boolean) =>
  $prose(
    () =>
      new Plugin({
        filterTransaction: (tr) => !tr.docChanged || !holding(),
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
    };
  });
  // The runtime of the place it is drawn in, for the editor's whole life.
  const plugins = usePluginRuntime();
  const [host] = useState<VisualHost>(() => ({
    links: () => latest.current.links,
    attachments: () => latest.current.attachments,
    live: new Set(),
    page: () => latest.current.page ?? null,
    plugins: () => plugins,
  }));
  const text = useRef(initial);
  // The editor once it's made, its writer, and the text it was last given,
  // with the document it made of it: an unchanged document gives it back.
  const editor = useRef<Editor | null>(null);
  const writer = useRef<Writer | null>(null);
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

  const docOf = (live: Editor) => live.action((ctx) => ctx.get(editorViewCtx).state.doc);
  // `doc` as Markdown, ending as the page it was given does, checked as
  // that. Before the page is all read back, the rest is read back now.
  const writing = (write: Writer, doc: Node, given: string) => write.write(doc, endsInLine(given));
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
      if (now.markdown === was.markdown) return (text.current = given.markdown);
      text.current = inLineBreaks(now.markdown, given.markdown, latest.current.lineBreak);
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
      const at = write.caret(doc, selection.head);
      if (at === null) return null;
      // In CRLF, each line break before it is a character longer.
      const lf = writing(write, doc, given.markdown).markdown;
      const crlf = markdown.length > lf.length ? lf.slice(0, at).split('\n').length - 1 : 0;
      return Math.min(at + crlf, markdown.length);
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
    /** Show `markdown`, changing only what differs so the cursor stays where it was. */
    show: (markdown: string) => {
      text.current = markdown;
      // A cursor asked for before it was made was in other text.
      focusing.current = null;
      editor.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const next = ctx.get(parserCtx)(withLf(markdown));
        const doc = unnumbered(view.state.doc);
        const read = unnumbered(next);
        const start = doc.content.findDiffStart(read.content);
        const end = doc.content.findDiffEnd(read.content);
        if (start !== null && end) {
          let { a, b } = end;
          const overlap = start - Math.min(a, b);
          if (overlap > 0) [a, b] = [a + overlap, b + overlap];
          view.dispatch(
            view.state.tr
              .replace(start, a, inPlace(view.state.doc, next, start, a, b))
              .setMeta(EXTERNAL, true)
              .setMeta('addToHistory', false),
          );
        }
        origin.current = { markdown, doc: view.state.doc };
      });
      surface.later();
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
  }));
  const [completion] = useState(
    () =>
      new LinkCompletion(
        () => latest.current.links,
        () => surface.read(),
      ),
  );
  const [format] = useState(() => new FormatWatch());

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
        ),
        typedLinks,
        autolinks,
        cellLinks,
        htmlBlocks,
        footnotes,
        unshownFootnotes,
        tableHeaders,
        codeHighlights,
        alerts,
        linkKeys(host),
        format.plugin,
        formatKeys,
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
        writer.current = next.action(
          (ctx) => new Writer({ parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) }),
        );
        origin.current = { markdown: given, doc: docOf(next) };
        // Text the session showed while it was being made.
        if (text.current !== given) surface.show(text.current);
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
      read: surface.read,
      replace: surface.show,
      caret: surface.caret,
      focus: surface.focus,
      insertCode: surface.insertCode,
    }),
    [surface],
  );

  // It fills the box the page editor gives it, the toolbar along its top
  // and the text scrolling below. The editable body is at least as tall as
  // what's left, so a click below the text lands in it.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-control border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <FormatToolbar watch={format} attachments={attachments.listed ?? attachments.list} />
      <div className="min-h-0 flex-1 overflow-y-auto [&_.milkdown]:h-full [&>[data-milkdown-root]]:h-full">
        <Milkdown />
        <CompletionListbox completion={completion} />
      </div>
    </div>
  );
}
