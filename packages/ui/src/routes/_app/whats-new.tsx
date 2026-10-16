import { createFileRoute } from '@tanstack/react-router';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import changelog from '../../../../../CHANGELOG.md?raw';
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
        <nav aria-label="Releases" className="grid gap-2">
          <p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
            Go to a release
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {releases.map(({ version }) => (
              <li key={version}>
                <button
                  type="button"
                  onClick={() => jump(version)}
                  className="rounded-full border border-border px-2.5 py-[3px] text-[12.5px] font-bold text-subtle-foreground hover:tint hover:text-foreground active:tint-strong"
                >
                  {version}
                </button>
              </li>
            ))}
          </ul>
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

function ReleaseNotes({
  release: { version, date, prerelease, highlights },
  open,
  onToggle,
}: {
  release: Release;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
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
          href={`${REPOSITORY}/releases/tag/v${version}`}
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
