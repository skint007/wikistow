import { createFileRoute } from '@tanstack/react-router';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import changelog from '../../../../../CHANGELOG.md?raw';
import { linkHint } from '../../desktop';
import { parseChangelog, REPOSITORY, type Release } from '../../whats-new/changelog';

export const Route = createFileRoute('/_app/whats-new')({ component: WhatsNew });

// The running build's version, set by the web app's Vite config.
declare const __APP_VERSION__: string;

// Released entries only: what has merged since isn't a release yet.
const { releases } = parseChangelog(changelog);
// A build between releases adds its commit, as `0.5.0+5b9e5ec4`.
const installed = __APP_VERSION__.split('+')[0];

const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

// Each release with its date and marks, found by its version or its date.
const choices: readonly ComboboxOption[] = releases.map((release) => ({
  value: release.version,
  label: day(release.date),
  marks: <ReleaseMarks release={release} />,
}));

/**
 * Every release's highlights from CHANGELOG.md, newest first: the newest
 * open, the rest a click or a jump away. Opened from the account menu, and
 * open while the vault is locked.
 */
function WhatsNew() {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(releases.slice(0, 1).map((r) => r.version)),
  );
  const toggle = (version: string, shown: boolean) =>
    setOpen((was) => {
      if (was.has(version) === shown) return was;
      const next = new Set(was);
      if (shown) next.add(version);
      else next.delete(version);
      return next;
    });
  // Opens the release and moves to it, so the keyboard carries on from there.
  // Open first, so there is room to bring it to the top.
  const jump = (version: string) => {
    flushSync(() => toggle(version, true));
    const summary = document.getElementById(`v${version}`)?.querySelector('summary');
    summary?.scrollIntoView({ block: 'start' });
    summary?.focus({ preventScroll: true });
  };

  return (
    <section
      data-region="whats-new"
      className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card"
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="grid gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold">What’s new</h1>
          <p className="text-sm text-muted-foreground">
            What each release of WikiStow changed, newest first. This is version {__APP_VERSION__}.
          </p>
        </header>
        <nav aria-label="Releases">
          <ReleaseFinder onPick={jump} />
        </nav>
        <ol className="grid gap-3">
          {releases.map((release) => (
            <li key={release.version}>
              <ReleaseNotes
                release={release}
                open={open.has(release.version)}
                onToggle={(shown) => toggle(release.version, shown)}
              />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * One field to go to any release, however many there are: typing a version
 * or a date narrows the list. Choosing one, or Enter for the version typed
 * or else the first listed, calls `onPick` with its version, and the field
 * empties again, as it does when left.
 */
function ReleaseFinder({ onPick }: { onPick: (version: string) => void }) {
  const [text, setText] = useState('');
  const pick = (version: string) => {
    setText('');
    onPick(version);
  };
  return (
    <div className="grid gap-2">
      <label
        htmlFor="release-finder"
        className="text-xs font-bold tracking-wide text-muted-foreground uppercase"
      >
        Go to a release
      </label>
      <Combobox
        id="release-finder"
        value={text}
        onChange={setText}
        options={choices}
        noun="releases"
        placeholder="Type a version or a date"
        onPick={pick}
        field={{
          autoComplete: 'off',
          // A search, not a choice: coming back, it lists every release again.
          onBlur: () => setText(''),
          onKeyDown: (event) => {
            // Not an option reached by the arrows, which the list takes, nor
            // Enter taking text being composed.
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            const query = text.trim().toLowerCase();
            if (!query) return;
            // The version typed in full, else the first listed, as the list matches.
            const first =
              choices.find((choice) => choice.value.toLowerCase() === query) ??
              choices.find(
                (choice) =>
                  choice.value.toLowerCase().includes(query) ||
                  choice.label?.toLowerCase().includes(query),
              );
            if (!first) return;
            event.preventDefault();
            pick(first.value);
          },
        }}
      />
    </div>
  );
}

/** A release's Prerelease and This version pills, as its heading and the finder show them. */
function ReleaseMarks({ release: { version, prerelease } }: { release: Release }) {
  if (!prerelease && version !== installed) return null;
  return (
    <span className="flex flex-wrap gap-1.5 text-[12.5px] font-bold">
      {prerelease && (
        <span className="rounded-full bg-status-draft px-2.5 py-[3px] text-status-draft-foreground">
          Prerelease
        </span>
      )}
      {version === installed && (
        <span className="rounded-full bg-status-published px-2.5 py-[3px] text-status-published-foreground ring-[1.5px] ring-current ring-inset">
          ✓ This version
        </span>
      )}
    </span>
  );
}

function ReleaseNotes({
  release,
  open,
  onToggle,
}: {
  release: Release;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const { version, date, highlights } = release;
  const changes = `${REPOSITORY}/releases/tag/v${version}`;
  return (
    <details
      id={`v${version}`}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="group rounded-control border border-border"
    >
      <summary className="flex scroll-mt-4 cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control px-4 py-3 hover:tint active:tint-strong [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open:rotate-90"
          strokeWidth={1.75}
        />
        <h2 className="text-lg font-extrabold">{version}</h2>
        <time dateTime={date} className="text-sm text-muted-foreground">
          {day(date)}
        </time>
        <ReleaseMarks release={release} />
      </summary>
      <div className="grid gap-4 px-4 pt-1 pb-4 pl-[42px] max-[899px]:pl-4">
        {highlights.map(({ category, items }) => (
          <section key={category} className="grid gap-1.5">
            <h3 className="text-sm font-bold">{category}</h3>
            <ul className="grid list-disc gap-1.5 pl-5 text-sm leading-relaxed">
              {items.map((item) => (
                <li key={item}>
                  <Highlight text={item} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        <a
          href={changes}
          {...linkHint(changes)}
          target="_blank"
          rel="noreferrer"
          className="flex w-fit items-center gap-1.5 text-sm font-bold text-primary-ink underline-offset-4 hover:underline"
        >
          <ExternalLink aria-hidden className="size-4" strokeWidth={1.75} />
          All changes in {version}
        </a>
      </div>
    </details>
  );
}

/** A highlight's text, with what's between backticks shown as code. */
function Highlight({ text }: { text: string }) {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="rounded-row bg-muted px-1.5 py-0.5 font-mono text-[0.9em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
