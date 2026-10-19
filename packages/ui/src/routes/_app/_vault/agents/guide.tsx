import { PageId, SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import linux from '../../../../agents/guide/linux.md?raw';
import macos from '../../../../agents/guide/macos.md?raw';
import windows from '../../../../agents/guide/windows.md?raw';
import { installationQuery } from '../../../../api';
import { Markdown } from '../../../../page/markdown';
import { useClient } from '../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/agents/guide')({ component: SetupGuide });

const SYSTEMS = [
  { system: 'linux', label: 'Linux', steps: linux },
  { system: 'macos', label: 'macOS', steps: macos },
  { system: 'windows', label: 'Windows', steps: windows },
] as const;

type System = (typeof SYSTEMS)[number]['system'];

/**
 * The system this browser runs on, read fresh each visit; Linux for
 * anything else. Chromium says `Windows` or `macOS`, other browsers'
 * user agents `Windows NT` or `Macintosh`.
 */
const thisSystem = (): System => {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
    navigator.userAgent;
  return /Win/.test(platform) ? 'windows' : /mac/i.test(platform) ? 'macos' : 'linux';
};

// The steps are read as a page body, which needs a page to name; there is none.
const NO_PAGE = { spaceId: SpaceId.parse('agents-guide'), pageId: PageId.parse('setup-guide') };

/**
 * How to set up a CLI agent, from nothing: install the CLI, enroll it,
 * hand it to an AI tool. Each system's steps are Markdown shipped with the
 * app (`agents/guide`), read by the page reader so their commands get its
 * copy button, with this server's address in place of `{{server}}`. The
 * Windows skill is written as ASCII, which it is: Windows PowerShell's
 * `utf8` starts the file with a byte order mark.
 */
function SetupGuide() {
  const ctx = useClient();
  const [system, setSystem] = useState(thisSystem);
  const { data, isPending } = useQuery(installationQuery);
  // The server names its own origin: the desktop app's pages live at
  // `app://`, which the CLI can't reach (as in `EnrollCommand`).
  const server = data?.origin ?? (isPending ? null : location.origin);
  const { label, steps } = SYSTEMS.find((entry) => entry.system === system) ?? SYSTEMS[0];

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="grid gap-1">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
            <Link to="/agents" className="quiet-link">
              Agents
            </Link>
            <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
            <span aria-current="page" className="text-muted-foreground">
              Setup guide
            </span>
          </nav>
          <h1 className="text-[32px] leading-tight font-extrabold">
            Set up an agent for the command line
          </h1>
          <p className="text-sm text-muted-foreground">
            About 5 minutes. You do this once per computer.
          </p>
        </header>
        <div className="grid gap-2 rounded-control bg-muted p-4 text-sm">
          <h2 className="font-bold">What you’ll need</h2>
          <ul className="grid list-disc gap-1 pl-5">
            <li>The computer the agent will run on, and a terminal on it.</li>
            <li>Your WikiStow sign-in. You’ll confirm it once while adding the agent.</li>
            <li>The folders you want the agent to see. You can change them later.</li>
          </ul>
        </div>
        <div role="group" aria-label="Your computer’s system" className="flex flex-wrap gap-1">
          {SYSTEMS.map((entry) => (
            <Button
              key={entry.system}
              size="sm"
              variant={entry.system === system ? 'secondary' : 'ghost'}
              aria-pressed={entry.system === system}
              onClick={() => setSystem(entry.system)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        {server && (
          <article
            aria-label={`Steps for ${label}`}
            // A long command scrolls in its block, not the page with it.
            className="min-w-0 [&_.page-body>h2:first-child]:mt-0"
          >
            <Markdown
              source={steps.replaceAll('{{server}}', server)}
              attachments={{ ctx, page: NO_PAGE, audience: 'published', attachments: [] }}
              pages={null}
              links={new Map()}
              editing={null}
            />
          </article>
        )}
      </div>
    </section>
  );
}
