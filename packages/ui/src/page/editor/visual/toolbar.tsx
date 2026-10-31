import type { AttachmentRef } from '@wikistow/client';
import { Plugin, PluginKey, type Command, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import {
  Bold,
  ChevronDown,
  Code,
  FileImage,
  FileText,
  FileUp,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Paperclip,
  SquareCode,
  TextQuote,
  type LucideIcon,
} from 'lucide-react';
import {
  Fragment,
  memo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { isApple } from '../../../shell/search-model';
import { ALERT_ICONS, QUOTE_KINDS } from '../../alert-title';
import {
  FORMATS,
  heading,
  headingShortcut,
  HEADINGS,
  quoteAs,
  quoteKind,
  SHORTCUTS,
  type FormatName,
  type QuoteKind,
} from './formatting';
import {
  attachable,
  destination,
  insertAttachment,
  insertLink,
  linkable,
  linkAround,
  removeLink,
  setLink,
} from './links';
import type { Upload } from './plugins';

let bars = 0;

const headingLabel = (level: number) => (level === 0 ? 'Text' : `Heading ${level}`);
const LEVELS = HEADINGS.map((level) => ({ level, format: heading(level) }));

const toQuote = quoteAs(null);

/** What the toolbar shows: the text style, and whether each format is on and applies. */
type Status = {
  style: string;
  level: number | null;
  formats: Record<FormatName, { active: boolean; applies: boolean }>;
  headings: boolean[];
  /** The kind of quote the selection is in, if any, and whether the quote menu applies. */
  quote: { kind: QuoteKind | undefined; applies: boolean };
  link: { active: boolean; applies: boolean };
  /** Whether an attachment can go in at the selection. */
  attachment: boolean;
};

function statusOf(state: EditorState): Status {
  const block = state.selection.$from.parent;
  const style =
    block.type.name === 'heading'
      ? headingLabel(Number(block.attrs['level']))
      : block.type.spec.code
        ? 'Code'
        : headingLabel(0);
  const level = LEVELS.find(({ format }) => format.active(state))?.level ?? null;
  const formats = Object.fromEntries(
    Object.entries(FORMATS).map(([name, format]) => [
      name,
      { active: format.active(state), applies: format.run(state) },
    ]),
  ) as Status['formats'];
  const headings = LEVELS.map(({ level: option, format }) => option === level || format.run(state));
  const link = { active: linkAround(state) !== null, applies: linkable(state) };
  const quote = { kind: quoteKind(state), applies: toQuote.run(state) };
  return { style, level, formats, headings, quote, link, attachment: attachable(state) };
}

type Range = { from: number; to: number };

/**
 * What the link control edits as it opens, over `range`: the link the
 * selection is in, the selected text, or a new link at the cursor.
 */
export type LinkTarget = Range &
  ({ kind: 'link'; href: string; removable: boolean } | { kind: 'selection' | 'cursor' });

function linkTargetOf(state: EditorState): LinkTarget | null {
  if (!linkable(state)) return null;
  const around = linkAround(state);
  if (around) {
    const { from, to, mark } = around;
    return {
      kind: 'link',
      from,
      to,
      href: String(mark.attrs['href']),
      removable: removeLink(state),
    };
  }
  const { from, to, empty } = state.selection;
  return { kind: empty ? 'cursor' : 'selection', from, to };
}

/**
 * The toolbar's status as the editor changes, kept the same object while
 * it shows the same, and the view to run commands on. Alt+F10 in the
 * editor moves to the toolbar.
 */
export class FormatWatch {
  readonly id = `format-toolbar-${++bars}`;
  #view: EditorView | null = null;
  #status: Status | null = null;
  #shown = '';
  readonly #listeners = new Set<() => void>();
  // The selection shown while a form of the toolbar's has the focus (`hold`).
  readonly #held = new PluginKey<DecorationSet>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  status = () => this.#status;

  #update(state: EditorState | null) {
    const status = state && statusOf(state);
    const shown = JSON.stringify(status);
    if (shown === this.#shown) return;
    [this.#status, this.#shown] = [status, shown];
    for (const listener of this.#listeners) listener();
  }

  /** Run `command` on the editor, which then has the focus again. */
  run(command: Command) {
    const view = this.#view;
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  }

  focusEditor() {
    this.#view?.focus();
  }

  /**
   * Highlight `range` while the focus is out of the editor, which then
   * shows no selection, as a form of the toolbar's works on it; null to stop.
   */
  hold(range: Range | null) {
    const view = this.#view;
    const shown = range && range.from < range.to ? range : null;
    view?.dispatch(view.state.tr.setMeta(this.#held, shown));
  }

  /** What the link control would edit now, or null if it doesn't apply. */
  linkTarget(): LinkTarget | null {
    return this.#view && linkTargetOf(this.#view.state);
  }

  /** The selection now, or null without an editor. */
  selection(): Range | null {
    const selection = this.#view?.state.selection;
    return selection ? { from: selection.from, to: selection.to } : null;
  }

  #upload: Upload | null = null;

  /** Given to `pasting`, which hands over its `Upload` once the editor's made. */
  readonly uploads = (upload: Upload | null) => {
    this.#upload = upload;
  };

  /** Upload `files` and put them in at the cursor, as pasted ones go. */
  upload(files: File[]) {
    if (files.length > 0) this.#upload?.(files);
  }

  readonly plugin = $prose(
    () =>
      new Plugin({
        key: this.#held,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, held) => {
            const range: Range | null | undefined = tr.getMeta(this.#held);
            if (range === undefined) return held.map(tr.mapping, tr.doc);
            if (range === null) return DecorationSet.empty;
            const shown = Decoration.inline(range.from, range.to, { class: 'bg-primary-soft' });
            return DecorationSet.create(tr.doc, [shown]);
          },
        },
        view: (view) => {
          this.#view = view;
          this.#update(view.state);
          return {
            update: (view, previous) => {
              const { doc, selection, storedMarks } = view.state;
              const same =
                doc === previous.doc &&
                selection.eq(previous.selection) &&
                storedMarks === previous.storedMarks;
              if (!same) this.#update(view.state);
            },
            destroy: () => {
              if (this.#view !== view) return;
              this.#view = null;
              this.#update(null);
            },
          };
        },
        props: {
          decorations: (state) => this.#held.getState(state),
          handleKeyDown: (_view, event) => {
            if (event.key !== 'F10' || !event.altKey) return false;
            document.getElementById(this.id)?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
            return true;
          },
        },
      }),
  );
}

const APPLE = typeof navigator !== 'undefined' && isApple();

/** A ProseMirror key name as the person presses it: `⌘⌥7` on Apple systems, `Ctrl+Alt+7` elsewhere. */
export function shortcutLabel(key: string): string {
  const parts = key.split('-');
  const last = parts.pop()?.toUpperCase() ?? '';
  const names = APPLE
    ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
    : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  const mods = parts.map((part) => names[part as keyof typeof names] ?? part);
  return APPLE ? [...mods, last].join('') : [...mods, last].join('+');
}

/** A ProseMirror key name as `aria-keyshortcuts` writes it: `Control+Alt+7`, `Meta+Alt+7` on Apple systems. */
function ariaShortcut(key: string): string {
  const parts = key.split('-');
  const last = parts.pop()?.toUpperCase() ?? '';
  const mods = parts.map((part) => (part === 'Mod' ? (APPLE ? 'Meta' : 'Control') : part));
  return [...mods, last].join('+');
}

const BUTTONS: { name: FormatName; label: string; icon: LucideIcon }[][] = [
  [
    { name: 'bold', label: 'Bold', icon: Bold },
    { name: 'italic', label: 'Italic', icon: Italic },
    { name: 'code', label: 'Inline code', icon: Code },
  ],
  [
    { name: 'quote', label: 'Quote', icon: TextQuote },
    { name: 'codeBlock', label: 'Code block', icon: SquareCode },
  ],
  [
    { name: 'bulletList', label: 'Bulleted list', icon: List },
    { name: 'orderedList', label: 'Numbered list', icon: ListOrdered },
    { name: 'taskList', label: 'Checklist', icon: ListChecks },
  ],
];

// A control's look: compact, muted until hovered, filled while it applies.
const CONTROL =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-row text-muted-foreground outline-none hover:tint active:tint-strong hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-none aria-disabled:hover:text-muted-foreground aria-disabled:active:bg-none aria-pressed:bg-primary-soft aria-pressed:text-primary-ink';

// Each control is its own memoized component: the status changes with
// most edits, and only the controls it changes for draw again.
type Roving = { tabbable: boolean; onFocus: (key: string) => void };

const roving = (key: string, { tabbable, onFocus }: Roving) => ({
  'data-control': key,
  tabIndex: tabbable ? 0 : -1,
  onFocus: () => onFocus(key),
});

/**
 * A toolbar menu's or popover's content handlers: as it closes, focus goes
 * back to the text, not the control, though not after a click outside it,
 * which took focus where it clicked (as Radix leaves it for its trigger).
 */
function useBackToText(watch: FormatWatch) {
  const outside = useRef(false);
  return {
    onInteractOutside: () => void (outside.current = true),
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (!outside.current) watch.focusEditor();
      outside.current = false;
    },
  };
}

// The text style menu: text or a heading level, those that don't apply off.
const TextStyle = memo(
  function TextStyle({
    watch,
    style,
    level,
    headings,
    ...focus
  }: Roving & {
    watch: FormatWatch;
    style: string;
    level: number | null;
    headings: readonly boolean[];
  }) {
    const backToText = useBackToText(watch);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          {...roving('heading', focus)}
          aria-label={`Text style: ${style}`}
          data-hint="Text style"
          className={cn(CONTROL, 'w-28 justify-between px-2 text-sm')}
        >
          <span className="truncate">{style}</span>
          <ChevronDown className="size-3.5" strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" {...backToText}>
          <DropdownMenuRadioGroup value={level === null ? '' : String(level)}>
            {LEVELS.map(({ level: option, format }, i) => (
              <DropdownMenuRadioItem
                key={option}
                value={String(option)}
                disabled={!headings[i]}
                onSelect={() => watch.run(format.run)}
              >
                {headingLabel(option)}
                <DropdownMenuShortcut>
                  {shortcutLabel(headingShortcut(option))}
                </DropdownMenuShortcut>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
  (a, b) =>
    a.style === b.style &&
    a.level === b.level &&
    a.tabbable === b.tabbable &&
    a.headings.join() === b.headings.join(),
);

const FormatButton = memo(function FormatButton({
  watch,
  name,
  label,
  icon: Icon,
  active,
  applies,
  className,
  ...focus
}: Roving & {
  watch: FormatWatch;
  name: FormatName;
  label: string;
  icon: LucideIcon;
  active: boolean;
  applies: boolean;
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      {...roving(name, focus)}
      aria-label={label}
      data-hint={label}
      data-hint-keys={shortcutLabel(SHORTCUTS[name])}
      aria-keyshortcuts={ariaShortcut(SHORTCUTS[name])}
      aria-pressed={active}
      // Not `disabled`, which would drop the focus as the selection moves.
      aria-disabled={!applies}
      // The editor keeps the focus and its selection.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => applies && watch.run(FORMATS[name].run)}
      className={cn(CONTROL, 'w-8', className)}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
});

const LINK_LABEL = { link: 'Edit link', selection: 'Add link', cursor: 'Insert link' } as const;

/**
 * The link control: pressed in a link, it opens a form to send the link
 * elsewhere or take it off, its text kept; on selected text, to link it;
 * at a cursor, to insert a link with its text. The editor keeps its
 * selection while the form is open, and has the focus again as it closes,
 * unless the person clicked elsewhere; cancelled, nothing changes.
 */
const LinkControl = memo(function LinkControl({
  watch,
  active,
  applies,
  ...focus
}: Roving & { watch: FormatWatch; active: boolean; applies: boolean }) {
  const [target, setTarget] = useState<LinkTarget | null>(null);
  const [text, setText] = useState('');
  const [href, setHref] = useState('');
  const backToText = useBackToText(watch);

  const onOpenChange = (open: boolean) => {
    const next = open ? watch.linkTarget() : null;
    watch.hold(next);
    setTarget(next);
    setText('');
    setHref(next?.kind === 'link' ? next.href : '');
  };
  const done = (command: Command) => {
    onOpenChange(false);
    watch.run(command);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const to = destination(href);
    if (!target || !to) return;
    done(target.kind === 'cursor' ? insertLink(text.trim() || href.trim(), to) : setLink(to));
  };

  return (
    <Popover open={target !== null} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...roving('link', focus)}
          aria-label="Link"
          data-hint="Link"
          aria-pressed={active}
          aria-disabled={!applies}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => !applies && event.preventDefault()}
          className={cn(CONTROL, 'w-8')}
        >
          <Link className="size-4" strokeWidth={1.75} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        aria-label={target ? LINK_LABEL[target.kind] : undefined}
        // Back to the text, its selection as it was, not the control.
        {...backToText}
      >
        <form onSubmit={submit} className="grid gap-3">
          {target?.kind === 'cursor' && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${watch.id}-link-text`}>Text</Label>
              <Input
                id={`${watch.id}-link-text`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Shown as the link"
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor={`${watch.id}-link-href`}>Link to</Label>
            <Input
              id={`${watch.id}-link-href`}
              value={href}
              onChange={(event) => setHref(event.target.value)}
              placeholder="https://example.com"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            {target?.kind === 'link' && target.removable && (
              <Button type="button" variant="outline" size="sm" onClick={() => done(removeLink)}>
                Remove link
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!href.trim()}>
              {target?.kind === 'link' ? 'Save' : 'Add link'}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
});

// The quote menu: the kind of quote the selection is in, and each to turn
// it into, or to quote the selection as.
const QuoteKindMenu = memo(function QuoteKindMenu({
  watch,
  kind,
  applies,
  ...focus
}: Roving & { watch: FormatWatch; kind: QuoteKind | undefined; applies: boolean }) {
  const current = QUOTE_KINDS.find((option) => option.kind === kind);
  const backToText = useBackToText(watch);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        {...roving('quoteKind', focus)}
        aria-label={current ? `Quote type: ${current.label}` : 'Quote type'}
        data-hint="Quote type"
        className={cn(CONTROL, 'w-4 rounded-l-none')}
      >
        <ChevronDown className="size-3.5" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" {...backToText}>
        <DropdownMenuRadioGroup value={current?.label ?? ''}>
          {QUOTE_KINDS.map(({ kind: option, label, icon: Icon }) => (
            <DropdownMenuRadioItem
              key={label}
              value={label}
              disabled={!applies}
              onSelect={() => watch.run(quoteAs(option).run)}
            >
              <Icon strokeWidth={1.75} />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

// What tells attachments apart in the picker, beside their names: their
// kind and size.
function described(ref: AttachmentRef) {
  const kind = ref.mediaType.startsWith('image/')
    ? 'Image'
    : (/\.(\w{1,8})$/.exec(ref.name)?.[1]?.toUpperCase() ?? 'File');
  return `${kind}, ${Math.ceil(ref.size / 1024)} KB`;
}

/**
 * The attachment picker: the page's attachments, each put in at the cursor
 * as often as wanted with no new upload, an image shown inline and any
 * other file a link to download it; and a file uploaded and put in at the
 * cursor, as one pasted is. The editor keeps its selection while it's open.
 */
const AttachmentControl = memo(function AttachmentControl({
  watch,
  attachments,
  applies,
  ...focus
}: Roving & { watch: FormatWatch; attachments: readonly AttachmentRef[]; applies: boolean }) {
  const [open, setOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const backToText = useBackToText(watch);
  const onOpenChange = (next: boolean) => {
    if (next && !applies) return;
    watch.hold(next ? watch.selection() : null);
    setOpen(next);
  };
  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          {...roving('attachment', focus)}
          aria-label="Insert attachment"
          data-hint="Insert attachment"
          aria-disabled={!applies}
          className={cn(CONTROL, 'w-8')}
        >
          <Paperclip className="size-4" strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72" {...backToText}>
          <DropdownMenuLabel>This page's attachments</DropdownMenuLabel>
          {attachments.length === 0 && (
            <DropdownMenuItem disabled>No attachments yet</DropdownMenuItem>
          )}
          {attachments.map((ref) => {
            const Icon = ref.mediaType.startsWith('image/') ? FileImage : FileText;
            return (
              <DropdownMenuItem key={ref.id} onSelect={() => watch.run(insertAttachment(ref))}>
                <Icon strokeWidth={1.75} />
                <span className="grid min-w-0">
                  <span className="truncate">
                    <Name>{ref.name}</Name>
                  </span>
                  <span className="text-xs text-muted-foreground">{described(ref)}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => file.current?.click()}>
            <FileUp strokeWidth={1.75} />
            Upload a file…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={file}
        type="file"
        multiple
        hidden
        aria-label="Upload and insert"
        onChange={(event) => {
          watch.upload(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
});

/**
 * Formatting for the visual editor: a heading menu, then bold, italic,
 * inline code, quote (with a menu of its kinds: an ordinary quote or one
 * of GitHub's alerts), code block and lists, each pressed while the
 * selection has it and taking it off then, a link and an attachment
 * picker (`attachments`, the page's). One stop in the tab order:
 * arrow keys, Home and End move along it, Escape goes back to the text.
 * It stays above the text as that scrolls, and wraps on a narrow window.
 */
export function FormatToolbar({
  watch,
  attachments,
}: {
  watch: FormatWatch;
  attachments: readonly AttachmentRef[];
}) {
  const status = useSyncExternalStore(watch.subscribe, watch.status);
  const bar = useRef<HTMLDivElement>(null);
  // The control Tab reaches, the last one focused.
  const [current, setCurrent] = useState('heading');

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys in the heading menu, which is elsewhere in the page, are its own.
    if (!bar.current?.contains(event.target as Node)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      return watch.focusEditor();
    }
    const controls = [...bar.current.querySelectorAll<HTMLElement>('[data-control]')];
    const at = controls.indexOf(event.target as HTMLElement);
    const next = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: controls.length - 1,
    }[event.key];
    if (at < 0 || next === undefined) return;
    event.preventDefault();
    controls[(next + controls.length) % controls.length]?.focus();
  };

  return (
    <div
      ref={bar}
      id={watch.id}
      role="toolbar"
      aria-label="Formatting"
      aria-controls="page-visual"
      onKeyDown={onKeyDown}
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-input px-1.5 py-1"
    >
      <TextStyle
        watch={watch}
        style={status?.style ?? headingLabel(0)}
        level={status?.level ?? null}
        headings={status?.headings ?? []}
        tabbable={current === 'heading'}
        onFocus={setCurrent}
      />
      {BUTTONS.map((group, i) => (
        <Fragment key={i}>
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
          {group.map((button) => {
            const kind = button.name === 'quote' ? status?.quote.kind : undefined;
            const control = (
              <FormatButton
                key={button.name}
                watch={watch}
                {...button}
                // In a quote, its kind's icon.
                icon={kind ? ALERT_ICONS[kind] : button.icon}
                active={status?.formats[button.name].active ?? false}
                applies={status?.formats[button.name].applies ?? false}
                tabbable={current === button.name}
                onFocus={setCurrent}
                className={button.name === 'quote' ? 'rounded-r-none' : undefined}
              />
            );
            if (button.name !== 'quote') return control;
            // A split button: the quote's toggle, then its kinds.
            return (
              <span key={button.name} className="flex">
                {control}
                <QuoteKindMenu
                  watch={watch}
                  kind={kind}
                  applies={status?.quote.applies ?? false}
                  tabbable={current === 'quoteKind'}
                  onFocus={setCurrent}
                />
              </span>
            );
          })}
        </Fragment>
      ))}
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
      <LinkControl
        watch={watch}
        active={status?.link.active ?? false}
        applies={status?.link.applies ?? false}
        tabbable={current === 'link'}
        onFocus={setCurrent}
      />
      <AttachmentControl
        watch={watch}
        attachments={attachments}
        applies={status?.attachment ?? false}
        tabbable={current === 'attachment'}
        onFocus={setCurrent}
      />
    </div>
  );
}
