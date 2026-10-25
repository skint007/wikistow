import { splitFrontmatter } from '@wikistow/client';
import { Plus } from 'lucide-react';
import {
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { emptyProperties, joinPage } from '../properties';
import { PropertiesEditor, type PropertyKeys } from '../properties-box';
import { pastedFiles } from './pasted-files';
import { preloadSourceEditor, SourceEditor } from './source-editor';
import { lineBreakOf, type EditorSurfaceHandle, type EditorSurfaceProps } from './surface';
import { BodyLoading, checkFidelity, VisualEditor } from './visual-editor';
import { fromAnotherTab } from './visual/copy-marks';
import type { Fidelity } from './visual/fidelity';

/** Source alone, the visual editor alone, or both side by side (split). */
export type EditorMode = 'source' | 'split' | 'visual';

const MODES: readonly EditorMode[] = ['source', 'split', 'visual'];
const LABELS = { source: 'Source', split: 'Split', visual: 'Visual' } satisfies Record<
  EditorMode,
  string
>;

// What the page editor shows: a mode, or the body as the visual editor's
// check of it runs, alone or beside the source.
type Shown = EditorMode | 'checking' | 'checking-split';

/** The mode the switch shows as picked. */
const picked = (shown: Shown): EditorMode =>
  shown === 'checking' ? 'visual' : shown === 'checking-split' ? 'split' : shown;

/** The editor whose text is the page's, `surface`: in split, the visual one. */
const mainOf = (shown: Shown) =>
  shown === 'source' ? 'source' : shown === 'visual' || shown === 'split' ? 'visual' : null;

// Which editor this device opens drafts in. A preference, not page content.
const PREFERENCE = 'wikistow.editor';

export function preferredMode(): EditorMode {
  try {
    const mode = window.localStorage.getItem(PREFERENCE);
    return mode === 'visual' || mode === 'split' ? mode : 'source';
  } catch {
    return 'source';
  }
}

const UNFAITHFUL =
  'The visual editor couldn’t write your last change exactly, so this page is in source mode. Check the text below.';

const NOT_LOADED: Fidelity = {
  visual: false,
  reason: 'The visual editor could not be loaded. Try again.',
};

// In split, why the visual side takes no edit: text in the source it wouldn't keep whole.
const onHold = (reason: string) =>
  `The visual side is on hold. ${reason.replace('This page stays in source mode, because', 'It can’t show the source as written, because')}`;

// In split, how long typing in the source pauses before the visual editor
// is given its text: at least this, and four times as long as it took last,
// as checking and reading a long page holds up the next key that long.
const SYNC_MS = 250;
const SYNC_SHARE = 4;

const check = (text: string) => checkFidelity(text).catch(() => NOT_LOADED);

function preferMode(mode: EditorMode) {
  try {
    window.localStorage.setItem(PREFERENCE, mode);
  } catch {
    // Not fatal: drafts open in the source editor.
  }
}

/**
 * The draft's Markdown, itself an editor surface over the whole text: its
 * frontmatter in Properties, split off before either editor sees it and
 * joined back as it was, and its body in the source or the visual editor,
 * or both side by side (split). The visual editor opens only on a body it
 * keeps whole (`checkFidelity`); any other stays in source mode, saying
 * why, as does text given to the visual editor later that it wouldn't keep
 * whole, and an edit it wrote as Markdown that reads otherwise. Text given
 * is checked before the visual editor reads it (`give`). That text has gone
 * to the session, to be saved, as every edit does; the source editor shows
 * the same text, the newest, with the cursor where it was. In split, each
 * side's edits go to the other: the visual editor's as it reports them, the
 * source's once typing pauses and they're checked; text it wouldn't keep
 * whole holds the visual side, saying why, until the source's is one it
 * would. The editor picked last is remembered on this device.
 */
export function PageEditor({
  initial,
  onChange,
  status,
  propertyKeys,
  ref,
  ...assist
}: EditorSurfaceProps & {
  status: ReactNode;
  /** The keys pages in this page's folder use, which Add property suggests. */
  propertyKeys?: PropertyKeys | undefined;
}) {
  const [first] = useState(() => splitFrontmatter(initial));
  const frontmatter = useRef(first.frontmatter);
  const [properties, setProperties] = useState(first.frontmatter);
  // Whether Properties was just added, to open on a new property's name.
  const [propertiesAdded, setPropertiesAdded] = useState(false);
  const body = useRef(first.body);
  // Text given that no editor shown holds yet, as the visual editor's
  // check of it runs: what the page holds until one does.
  const given = useRef<string | null>(null);
  const surface = useRef<EditorSurfaceHandle | null>(null);
  // In split, the source editor beside the visual one, `surface`.
  const mirror = useRef<EditorSurfaceHandle | null>(null);
  // Where the next surface shown is focused, once it's there.
  const focusAt = useRef<{ at: number | undefined } | null>(null);
  const [mode, setShown] = useState<Shown>(() => {
    const preferred = preferredMode();
    return preferred === 'source'
      ? 'source'
      : preferred === 'split'
        ? 'checking-split'
        : 'checking';
  });
  // The mode as last set, for text the session gives before it's shown.
  const modeNow = useRef(mode);
  // In split, the source's text waiting for the visual editor (`syncVisual`),
  // and how long giving it the last took.
  const syncing = useRef<{ timer: ReturnType<typeof setTimeout>; run: () => void } | null>(null);
  // In split, the side the person was in last, where Insert in page puts its code.
  const lastSide = useRef<'source' | 'visual'>('visual');
  const synced = useRef(0);
  const [attach] = useState(() => (handle: EditorSurfaceHandle | null) => {
    surface.current = handle;
    if (!handle) return;
    // In split, the source's text still being checked goes in once it is.
    if (modeNow.current !== 'split' || given.current === null) {
      given.current = null;
      // An edit the last surface reported as it went, after this one was drawn.
      if (handle.read() !== body.current) handle.replace(body.current);
    }
    const focus = focusAt.current;
    focusAt.current = null;
    // Unless the person went elsewhere meanwhile.
    const free = !document.activeElement || document.activeElement === document.body;
    if (focus && free) handle.focus(focus.at);
  });
  const [attachMirror] = useState(() => (handle: EditorSurfaceHandle | null) => {
    mirror.current = handle;
    if (handle && handle.read() !== body.current) handle.replace(body.current);
  });
  const setMode = (next: Shown) => {
    // The editor the page reads is going: text given now is for the next.
    if (mainOf(next) !== mainOf(modeNow.current)) surface.current = null;
    if (next !== 'split' && syncing.current) {
      clearTimeout(syncing.current.timer);
      syncing.current = null;
    }
    modeNow.current = next;
    setShown(next);
  };
  const [note, setNote] = useState<string | null>(null);
  const asked = useRef(0);
  // An editor still loading takes the body it's shown with when it's made.
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const bodyNow = () => given.current ?? surface.current?.read() ?? body.current;
  const changed = (text = bodyNow()) => {
    body.current = text;
    onChange(joinPage(frontmatter.current, text));
  };
  const setFrontmatter = (block: string | null) => {
    frontmatter.current = block;
    setProperties(block);
  };

  /** Show the body in `next`, the visual editor only if it keeps the body whole. */
  const show = async (next: EditorMode, remember: boolean) => {
    const ask = ++asked.current;
    body.current = bodyNow();
    if (remember) preferMode(next);
    if (next === 'source') {
      setMode('source');
      setNote(null);
      return;
    }
    // The visual editor holds the body already: only the source beside it comes or goes.
    if (mainOf(modeNow.current) === 'visual' && surface.current && given.current === null) {
      setMode(next);
      setNote(null);
      return;
    }
    setMode(next === 'split' ? 'checking-split' : 'checking');
    // Text given meanwhile, pasted or from the session, is checked in turn.
    let checked: string;
    let fidelity: Fidelity;
    do {
      checked = body.current;
      fidelity = await check(checked);
      if (ask !== asked.current) return;
    } while (checked !== body.current);
    setMode(fidelity.visual ? next : 'source');
    setNote(fidelity.visual ? null : fidelity.reason);
  };

  /**
   * In split, give the visual editor `text`, the source's, after `wait`
   * ms, or at once as the person turns to it (`syncNow`), checked first as
   * `give` does; meanwhile it takes no edit. If it wouldn't keep `text`
   * whole, it goes on taking none, saying why, until the source's text is
   * one it would, and typing goes on in the source.
   */
  const syncVisual = (text: string, wait: number) => {
    given.current = text;
    if (syncing.current) clearTimeout(syncing.current.timer);
    const ask = asked.current;
    const run = () => {
      syncing.current = null;
      const started = performance.now();
      void check(text).then((fidelity) => {
        if (given.current !== text || ask !== asked.current) return;
        const focus = focusAt.current;
        focusAt.current = null;
        if (!fidelity.visual) {
          setNote(onHold(fidelity.reason));
          if (focus) mirror.current?.focus(focus.at);
          return;
        }
        given.current = null;
        setNote(null);
        // Not yet made, it takes the page's text when it is.
        if (!surface.current) return;
        surface.current.replace(text);
        synced.current = performance.now() - started;
        if (focus) surface.current.focus(focus.at);
      });
    };
    syncing.current = { timer: setTimeout(run, wait), run };
  };

  /**
   * In split, the source's text waiting for the visual editor, given now, as
   * the person turns to it. It takes no key until it has it.
   */
  const syncNow = () => {
    const waiting = syncing.current;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting.run();
  };

  /**
   * In split, the visual editor's last edit, not yet reported, taken now
   * as the person turns to the source, so typing there starts from it.
   */
  const takeVisual = () => {
    if (modeNow.current !== 'split' || given.current !== null) return;
    const text = surface.current?.read();
    if (text === undefined || text === body.current) return;
    changed(text);
    mirror.current?.replace(text);
  };

  /**
   * Show `text`, given from outside the editor: the session's, or pasted
   * into an empty page. The visual editor reads what it's given at once,
   * on the page's thread, which text its check keeps out could hold up for
   * seconds, so it's given only text that passed. Meanwhile the page holds
   * `text`: shown at once while it's checked if `atOnce`, or if the visual
   * editor isn't there yet, as when turning to it; else the visual editor
   * shows what it had, taking no edit (`holding`), and files uploaded
   * meanwhile go after the text (`onFiles`).
   */
  const give = (text: string, atOnce: boolean) => {
    // As the frontmatter alone changes.
    if (text === bodyNow()) return;
    // A cursor kept for the next editor was in other text.
    focusAt.current = null;
    body.current = text;
    if (given.current !== null) given.current = text;
    mirror.current?.replace(text);
    if (modeNow.current === 'split') return syncVisual(text, 0);
    if (modeNow.current !== 'visual') {
      // In source mode, or while the check runs, which checks it next.
      if (surface.current) surface.current.replace(text);
      else redraw();
      return;
    }
    given.current = text;
    if (atOnce || !surface.current) return void show('visual', false);
    const ask = asked.current;
    void check(text).then((fidelity) => {
      if (given.current !== text || ask !== asked.current) return;
      if (fidelity.visual) {
        given.current = null;
        surface.current?.replace(text);
        return;
      }
      asked.current++;
      setMode('source');
      setNote(fidelity.reason);
    });
  };

  /**
   * An edit the visual editor wrote as Markdown that reads otherwise: the
   * page's text now, typed since included, shown in the source editor at
   * once, saying so, before another key goes to the visual one.
   */
  const unfaithful = () => {
    if (modeNow.current !== 'visual' && modeNow.current !== 'split') return;
    asked.current++;
    body.current = bodyNow();
    const typing = !!document.activeElement?.closest('#page-visual');
    // Where it was in what it shows, unless that isn't the text given since.
    const caret = given.current === null ? surface.current?.caret?.() : null;
    if (typing) focusAt.current = { at: caret ?? undefined };
    flushSync(() => {
      setMode('source');
      setNote(UNFAITHFUL);
    });
  };

  /**
   * Put inline code, a property reference, where the cursor is in the
   * editor the person was in last (in split, either side), and turn to it.
   * While neither takes edits (the visual editor's check of given text
   * runs), at the body's end.
   */
  const insertCode = (code: string) => {
    const source =
      modeNow.current === 'split' && (lastSide.current === 'source' || given.current !== null);
    const target = source ? mirror.current : given.current === null ? surface.current : null;
    if (target?.insertCode) {
      target.insertCode(code);
      return;
    }
    const text = bodyNow();
    const lineBreak = lineBreakOf(frontmatter.current ?? text);
    const next = `${text}${text === '' || text.endsWith('\n') ? '' : lineBreak}\`${code}\`${lineBreak}`;
    give(next, false);
    changed(next);
  };

  // The source editor too, which an edit the visual editor can't write turns to.
  useEffect(() => {
    if (mode === 'visual') preloadSourceEditor();
  }, [mode]);

  // A draft opened where the visual editor was picked last.
  const opening = useRef(mode === 'checking' || mode === 'checking-split');
  useEffect(() => {
    if (!opening.current) return;
    opening.current = false;
    void show(picked(mode), false);
  });

  // The source's text still waiting goes nowhere once the editor has gone.
  useEffect(
    () => () => {
      if (syncing.current) clearTimeout(syncing.current.timer);
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      read: () => joinPage(frontmatter.current, bodyNow()),
      replace(markdown) {
        const split = splitFrontmatter(markdown);
        if (split.frontmatter !== frontmatter.current) setFrontmatter(split.frontmatter);
        give(split.body, false);
      },
      focus: () => surface.current?.focus(),
    }),
    [],
  );

  // Text pasted into an empty page: frontmatter at its start fills
  // Properties, and in the visual editor, a body it can't keep whole opens
  // in the source editor instead. Rich text whose text is Markdown another
  // of this browser's WikiStow tabs copied is that text.
  const pasteIntoEmpty = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    const text = data.getData('text/plain');
    if (frontmatter.current !== null || bodyNow() !== '' || pastedFiles(data).length > 0) return;
    const split = splitFrontmatter(text);
    const html = data.getData('text/html') !== '' && !fromAnotherTab(data);
    const visual =
      mode === 'visual' ||
      (mode === 'split' &&
        event.target instanceof Element &&
        !!event.target.closest('#page-visual'));
    if (!text || (split.frontmatter === null && (!visual || html))) return;
    event.preventDefault();
    event.stopPropagation();
    if (split.frontmatter !== null) setFrontmatter(split.frontmatter);
    const typing = !!document.activeElement?.closest('#page-visual');
    // As it is, at once: the visual editor gives back text it was given unchanged.
    give(split.body, true);
    changed(split.body);
    // Typing goes on at its end, in whichever editor it ends up in.
    if (split.body && typing) focusAt.current = { at: split.body.length };
  };

  const lineBreak = lineBreakOf(frontmatter.current ?? '');
  const surfaceProps: EditorSurfaceProps = {
    ...assist,
    ref: attach,
    initial: body.current,
    // Not while text it was given is held: that has what it reports.
    onChange: (text) => {
      if (given.current !== null) return;
      changed(text);
      mirror.current?.replace(text);
    },
    onFiles: (files, place) =>
      assist.onFiles(files, (markdown) => given.current === null && place(markdown)),
    lineBreak,
  };
  // The source beside the visual editor: its edits go there once typing pauses.
  const mirrorProps: EditorSurfaceProps = {
    ...assist,
    ref: attachMirror,
    initial: body.current,
    onChange: (text) => {
      changed(text);
      if (modeNow.current === 'split')
        syncVisual(text, Math.max(SYNC_MS, SYNC_SHARE * synced.current));
    },
    lineBreak,
  };
  const chosen = picked(mode);
  const checking = mode === 'checking' || mode === 'checking-split';

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        {status}
        <div className="flex items-center gap-2">
          {properties === null && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFrontmatter(emptyProperties(lineBreakOf(body.current)));
                setPropertiesAdded(true);
                changed();
              }}
            >
              <Plus className="size-4" strokeWidth={1.75} />
              Add properties
            </Button>
          )}
          <div
            role="group"
            aria-label="Editor"
            className="inline-flex rounded-control border border-input p-0.5"
          >
            {MODES.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={choice === chosen}
                // Not `disabled`, which would drop the focus while it checks.
                aria-disabled={checking}
                onClick={() => {
                  if (choice !== chosen && !checking) void show(choice, true);
                }}
                className={cn(
                  'rounded-row px-2.5 py-1 font-bold text-muted-foreground not-aria-disabled:hover:tint not-aria-disabled:hover:text-foreground not-aria-disabled:active:tint-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-wait',
                  choice === chosen && 'bg-muted text-foreground',
                )}
              >
                {LABELS[choice]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div role="status">
        {note && <p className="rounded-control bg-muted px-3 py-2 text-sm">{note}</p>}
      </div>
      {properties !== null && (
        <PropertiesEditor
          frontmatter={properties}
          adding={propertiesAdded}
          scope={{
            spaceId: assist.page?.spaceId ?? '',
            selfId: assist.links.selfId,
            pages: assist.links.pages,
            links: assist.links.table,
            editor: true,
          }}
          onChange={(block) => {
            setFrontmatter(block);
            changed();
          }}
          onRemove={() => {
            setFrontmatter(null);
            setPropertiesAdded(false);
            changed();
          }}
          onInsert={insertCode}
          propertyKeys={propertyKeys}
        />
      )}
      {/* The editor fills the space the page leaves it, at least two fifths of
          the window (all of it, less the top bar, on phones), and scrolls
          within it, so a long page doesn't stretch the page around it. In
          split, the source is on the left and the visual editor on the
          right, or where the card is narrow, above it, each half as tall. */}
      <div
        onPasteCapture={pasteIntoEmpty}
        className={cn(
          'relative min-h-[max(16rem,40svh)] flex-1 max-[899px]:min-h-[calc(100svh-5rem-var(--titlebar-height))]',
          chosen === 'split' && '@max-[799px]:min-h-[calc(100svh-5rem-var(--titlebar-height))]',
        )}
      >
        <div
          className={cn(
            'absolute inset-0 grid gap-4',
            chosen === 'split' && 'grid-rows-2 @min-[800px]:grid-cols-2 @min-[800px]:grid-rows-1',
          )}
        >
          {mode !== 'visual' && mode !== 'checking' && (
            <div
              key="source"
              className="min-h-0 min-w-0"
              onFocusCapture={() => {
                lastSide.current = 'source';
                takeVisual();
              }}
            >
              <SourceEditor {...(mode === 'source' ? surfaceProps : mirrorProps)} />
            </div>
          )}
          {mode !== 'source' && (
            <div
              key="visual"
              // As the pointer comes, before a click, so a key typed there isn't left out.
              onPointerEnter={syncNow}
              onFocusCapture={() => {
                lastSide.current = 'visual';
                syncNow();
              }}
              className={cn('min-h-0 min-w-0', mode === 'split' && note && 'opacity-60')}
            >
              {checking ? (
                <BodyLoading text={body.current} />
              ) : (
                <VisualEditor
                  {...surfaceProps}
                  onUnfaithful={unfaithful}
                  holding={() => given.current !== null}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
