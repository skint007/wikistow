import {
  Banner,
  CoverIcon,
  CoverSymbol,
  pageMerge,
  PageEmoji,
  type AttachmentRef,
  type ClientContext,
  type pageOperations,
  type PagePayload,
} from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Picture } from '@/components/symbol-icon';
import { cn } from '@/lib/utils';
import { decryptedQuery } from '../attachments';
import { coverStyle } from '../cover/cover-style';
import {
  fieldLine,
  foldSame,
  keptChoices,
  offerOf,
  overlapPlace,
  summaryOf,
  theirsWords,
  type Choice,
  type Choices,
  type Theirs,
} from './merge-model';

type Merge = pageMerge.Merge;
type Overlap = pageMerge.Overlap;
type Review = pageMerge.Review;

const MONO = 'font-mono text-[13px] leading-relaxed whitespace-pre-wrap wrap-anywhere';

/** Where the merge view finds the pictures a banner or icon overlap shows: the page's draft attachments. */
export type MergePictures = {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  attachments: readonly AttachmentRef[];
};

/**
 * Merging the person's edit with theirs (ADR 0013, decisions 6 and 7), in
 * place of the editor: choosing at each place both changed, then reviewing
 * what saving changes in theirs. Nothing is saved before **Save merged
 * draft**, which hands the payload to `onSave`; **Cancel** leaves
 * everything as it was.
 */
export function MergeView({
  merge: merged,
  theirs,
  pictures,
  onSave,
  onCancel,
}: {
  merge: Merge;
  theirs: Theirs;
  pictures: MergePictures;
  onSave: (payload: PagePayload) => void;
  onCancel: () => void;
}) {
  const words = theirsWords(theirs);
  // With nothing to choose, straight to the review.
  const [state, setState] = useState(() => {
    const resolved = merged.overlaps.length === 0 ? pageMerge.resolve(merged, {}) : null;
    return {
      merge: resolved?.ok === false ? resolved.merge : merged,
      review: resolved?.ok ? resolved : null,
      unfit: resolved?.ok === false,
    };
  });
  const [choices, setChoices] = useState<Choices>({});
  const { merge, review } = state;
  const heading = useRef<HTMLHeadingElement>(null);
  const step = review ? 'review' : 'choose';
  useLayoutEffect(() => heading.current?.focus(), [step]);

  const toReview = () => {
    const resolved = pageMerge.resolve(merge, choices);
    if (resolved.ok) setState({ merge, review: resolved, unfit: false });
    else {
      // Some blocks didn't read as chosen where they went: choose there.
      setChoices(keptChoices(resolved.merge, choices));
      setState({ merge: resolved.merge, review: null, unfit: true });
    }
  };
  const chosen = merge.overlaps.filter((overlap) => choices[overlap.id] !== undefined).length;

  return (
    <section aria-labelledby="merge-heading" className="grid gap-4">
      <div className="grid gap-2">
        <h2
          id="merge-heading"
          ref={heading}
          tabIndex={-1}
          className="text-xl font-extrabold outline-none"
        >
          Merge your changes with {words.with}
        </h2>
        <ol aria-label="Steps" className="flex gap-2 text-sm">
          {(['choose', 'review'] as const).map((name, index) => (
            <li
              key={name}
              aria-current={step === name ? 'step' : undefined}
              className={cn(
                'rounded-full px-3 py-0.5',
                step === name ? 'bg-primary-soft font-bold text-primary-ink' : 'bg-muted',
              )}
            >
              {index + 1} · {name === 'choose' ? 'Choose' : 'Review'}
            </li>
          ))}
        </ol>
      </div>
      {review ? (
        <ReviewStep
          review={review.review}
          summary={merge.overlaps.length === 0 ? summaryOf(merge, theirs) : null}
          draft={words.draft}
          onBack={merge.overlaps.length > 0 ? () => setState({ ...state, review: null }) : null}
          onCancel={onCancel}
          onSave={() => onSave(review.payload)}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {state.unfit
              ? 'Some changes didn’t fit where they went. Choose what each should say.'
              : summaryOf(merge, theirs)}
          </p>
          <ol className="grid gap-3">
            {merge.overlaps.map((overlap, index) => (
              <OverlapCard
                key={overlap.id}
                overlap={overlap}
                number={`${index + 1} of ${merge.overlaps.length}`}
                theirs={theirs}
                pictures={pictures}
                choice={choices[overlap.id]}
                onChoose={(choice) => setChoices((before) => ({ ...before, [overlap.id]: choice }))}
              />
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <p className="text-sm text-muted-foreground">
              {chosen} of {merge.overlaps.length} chosen
            </p>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button disabled={chosen < merge.overlaps.length} onClick={toReview}>
                Review merged draft
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** One place both changed: yours and theirs side by side, and the choices it offers. */
function OverlapCard({
  overlap,
  number,
  theirs,
  pictures,
  choice,
  onChoose,
}: {
  overlap: Overlap;
  number: string;
  theirs: Theirs;
  pictures: MergePictures;
  choice: Choice | undefined;
  onChoose: (choice: Choice) => void;
}) {
  const words = theirsWords(theirs);
  // What was typed in Edit…, kept while another choice is tried.
  const [edited, setEdited] = useState<string | null>(null);
  const place = overlapPlace(overlap);
  const label = [place, number].filter(Boolean).join(' · ');
  const unfit = overlap.part === 'body' && !overlap.fits;
  const offered = (offer: pageMerge.Offer) => overlap.offers.includes(offer);
  const editing = choice !== undefined && offerOf(choice) === 'edit';
  const button = (offer: pageMerge.Offer, text: string, make: () => Choice) =>
    offered(offer) && (
      <ChoiceButton
        pressed={choice !== undefined && offerOf(choice) === offer}
        onClick={() => onChoose(make())}
      >
        {text}
      </ChoiceButton>
    );
  const draft = 'draft' in overlap ? overlap.draft : '';

  return (
    <li aria-label={label} className="grid gap-2 rounded-control border p-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      {unfit && <p className="text-sm">This didn’t fit where it went.</p>}
      {overlap.part === 'body' && overlap.before !== null && (
        <p className={cn(MONO, 'text-muted-foreground')}>{overlap.before}</p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Side title="Yours">
          <Value overlap={overlap} side="yours" pictures={pictures} />
        </Side>
        <Side title={words.side}>
          <Value overlap={overlap} side="theirs" pictures={pictures} />
        </Side>
      </div>
      {editing && (
        <textarea
          aria-label={`Edit ${label}`}
          value={typeof choice === 'object' ? choice.edit : ''}
          spellCheck={false}
          onChange={(event) => {
            setEdited(event.target.value);
            onChoose({ edit: event.target.value });
          }}
          className={cn(
            MONO,
            'field-sizing-content min-h-16 w-full resize-y rounded-control border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        />
      )}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {button('yours', 'Use yours', () => 'yours')}
        {button('theirs', words.use, () => 'theirs')}
        {button('both', 'Use both', () => 'both')}
        {button('edit', editing ? 'Edited' : 'Edit…', () => ({ edit: edited ?? draft }))}
      </div>
    </li>
  );
}

function ChoiceButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(pressed && 'border-primary bg-primary-soft text-primary-ink')}
    >
      {pressed && <Check aria-hidden />}
      {children}
    </Button>
  );
}

function Side({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1 rounded-control bg-muted p-3">
      <p className="text-sm font-bold">{title}</p>
      {children}
    </div>
  );
}

/** One side of an overlap: its text with the words it changed from the base marked, or its picture. */
function Value({
  overlap,
  side,
  pictures,
}: {
  overlap: Overlap;
  side: 'yours' | 'theirs';
  pictures: MergePictures;
}) {
  switch (overlap.part) {
    case 'banner':
    case 'icon':
      return <CoverValue part={overlap.part} value={overlap[side]} pictures={pictures} />;
    case 'data':
      return (
        <p className={MONO}>
          {overlap[side] === null ? 'None' : JSON.stringify(overlap[side], null, 1)}
        </p>
      );
    default:
      return (
        <p className={MONO}>
          {overlap[side] === '' ? (
            <span className="font-sans text-muted-foreground">Nothing here</span>
          ) : (
            <Marked marks={pageMerge.wordMarks(overlap.base, overlap[side])} />
          )}
        </p>
      );
  }
}

/** Text with its added and taken out words marked. */
function Marked({ marks }: { marks: readonly pageMerge.Mark[] }) {
  return marks.map((mark, index) =>
    mark.change === 'added' ? (
      <ins key={index} className="bg-diff-added text-diff-added-foreground no-underline">
        {mark.text}
      </ins>
    ) : mark.change === 'removed' ? (
      <del key={index} className="bg-diff-removed text-diff-removed-foreground line-through">
        {mark.text}
      </del>
    ) : (
      <span key={index}>{mark.text}</span>
    ),
  );
}

type Json = PagePayload['extensions'][string];

/** A banner or icon as the page would show it. */
function CoverValue({
  part,
  value,
  pictures,
}: {
  part: 'banner' | 'icon';
  value: Json | null;
  pictures: MergePictures;
}) {
  const banner = part === 'banner' ? Banner.safeParse(value) : null;
  const icon = part === 'icon' && isObject(value) ? value : null;
  const image = banner?.success
    ? banner.data.kind === 'image'
      ? banner.data.attachmentId
      : null
    : icon && CoverIcon.safeParse(icon.icon).data?.attachmentId;
  const ref = pictures.attachments.find((a) => a.id === image);
  const { data: url } = useQuery(
    decryptedQuery({ ctx: pictures.ctx, page: pictures.page, audience: 'draft' }, ref),
  );
  if (banner?.success)
    return (
      <div
        role="img"
        aria-label="Banner"
        className="bg-cover-band h-12 w-full max-w-48 rounded-row"
        style={coverStyle(banner.data, url)}
      />
    );
  const emoji = icon && PageEmoji.safeParse(icon.emoji).data;
  const symbol = icon && CoverSymbol.safeParse(icon.symbol).data?.name;
  if (!emoji && !symbol && !image) return <p className="text-sm text-muted-foreground">None</p>;
  return (
    <span role="img" aria-label="Icon" className="grid size-10 place-items-center text-2xl">
      <Picture image={url ?? null} symbol={symbol ?? null} emoji={emoji ?? null} />
    </span>
  );
}

const isObject = (value: Json | null): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What saving changes in theirs, block by block: changed blocks with their
 * words marked, added ones in green, taken out ones in red, and unchanged
 * runs folded.
 */
function ReviewStep({
  review,
  summary,
  draft,
  onBack,
  onCancel,
  onSave,
}: {
  review: Review;
  summary: string | null;
  draft: string;
  onBack: (() => void) | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { lines, fields } = review;
  const changes = lines.some((line) => line.kind !== 'same') || fields.length > 0;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {summary && `${summary} `}
        {changes
          ? `Saving makes these changes to ${draft}.`
          : `Saving changes nothing in ${draft}.`}
      </p>
      {changes && (
        <ol
          aria-label="Changes"
          className="grid grid-cols-1 overflow-hidden rounded-control border bg-card text-[13px]"
        >
          {lines.map((line, index) => (
            <ReviewRow
              key={index}
              line={line}
              first={index === 0}
              last={index === lines.length - 1}
            />
          ))}
        </ol>
      )}
      {fields.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {fields.map((field) => (
            <li key={field.part === 'data' ? `data:${field.namespace}` : field.part}>
              {fieldLine(field)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        )}
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSave}>Save merged draft</Button>
      </div>
    </>
  );
}

function ReviewRow({
  line,
  first,
  last,
}: {
  line: pageMerge.ReviewLine;
  first: boolean;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const row = (sign: string, children: ReactNode, className?: string) => (
    <li className={cn('flex gap-3 px-3 py-0.5', className)}>
      <span aria-hidden className="w-3 shrink-0 font-mono text-muted-foreground">
        {sign}
      </span>
      <span className={cn(MONO, 'min-w-0 flex-1')}>{children}</span>
    </li>
  );
  switch (line.kind) {
    case 'changed':
      return row('~', <Marked marks={line.marks} />);
    case 'added':
      return row(
        '+',
        <ins className="no-underline">{line.text.replace(/\n+$/, '')}</ins>,
        'bg-diff-added text-diff-added-foreground',
      );
    case 'removed':
      return row(
        '−',
        <del className="no-underline">{line.text.replace(/\n+$/, '')}</del>,
        'bg-diff-removed text-diff-removed-foreground',
      );
    case 'same': {
      const { before, folded, after } = foldSame(line.text, { first, last });
      const shown = (lines: string[]) =>
        lines.length > 0 && row('', lines.join('\n'), 'text-subtle-foreground');
      return (
        <>
          {shown(before)}
          {folded.length > 0 &&
            (open ? (
              shown(folded)
            ) : (
              <li className="bg-muted">
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="w-full px-3 py-0.5 text-left text-xs text-muted-foreground hover:tint"
                >
                  ⋯ {folded.length} unchanged {folded.length === 1 ? 'line' : 'lines'}
                </button>
              </li>
            ))}
          {shown(after)}
        </>
      );
    }
  }
}
