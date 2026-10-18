// What `wikistow --help` and `wikistow <command> --help` print: enough for
// an agent to work out the read, draft, attach, publish loop without
// guessing which revision ID goes where.
import { kilobytes } from '@wikistow/client';
import { pageRoutes } from '@wikistow/contracts';
import packageJson from '../package.json' with { type: 'json' };
import type { CommandName } from './cli.ts';

export const VERSION = packageJson.version;

const RETRYING = `Retrying a change:
  Give create, draft, attach and publish --idempotency-key KEY, a new KEY for
  each new change. Running the same command again with the same KEY and the
  same input never makes the change twice: if the first run's answer came
  back, it is reported again and nothing is sent; if not, the first run's
  exact request is sent again. So retrying with the same KEY is safe after
  any failure, and is the thing to do when --json says "outcomeUnknown":
  true: no answer came back, or the server failed, so the change may have
  happened. After any other failure nothing changed, and the key is free
  again. The same KEY with other input (another file, title or revision) is
  refused while the first run's change may still land, or has landed.
  The server keeps KEY for a day. A change first sent over a day ago and
  refused now may have been made by the first run, and be what is in the
  way. That is reported with "outcomeUnknown": true and exit 1, and the key
  stays taken: check (tree, page read --draft) before trying again with a
  new KEY.
  Without a KEY, check (tree, page read) before running a change again.
  page unpublish and page publish-to take no KEY: each names what it
  changes, so run it again as it was (see their --help).
  The CLI keeps each keyed change, encrypted, in ~/.config/wikistow/journal/,
  until a day after its answer came back, as long as the server keeps KEY.
`;

export const USAGE = `Usage: wikistow <command> [options]
       wikistow <command> --help     what one command does, in detail
       wikistow --version

Commands:
  agent enroll --server URL [--secret-store [--secret-tool PATH]]
  agent status                    (also: whoami)
  agent secret-store enable|disable [--secret-tool PATH]
  skill                           a skill that teaches an agent this CLI
  spaces list
  tree --space SPACE_ID
  search QUERY [--space SPACE_ID]
  export --out DIR [--space SPACE_ID] [--folder FOLDER_ID]
  page read PAGE_ID [--draft] [--revision REVISION_ID]
  page create --folder FOLDER_ID --title TITLE --file PATH|- [--space SPACE_ID]
  page draft PAGE_ID --base REVISION_ID --file PATH|- [--title TITLE]
  page attach PAGE_ID --file PATH|- [--name NAME] [--media-type TYPE] [--base REVISION_ID]
  page publish PAGE_ID --revision REVISION_ID --base-published PUBLISHED_ID|none
                  [--permission-version N]
  page unpublish PAGE_ID --base-published PUBLISHED_ID
  page publish-to PAGE_ID --space SPACE_ID [--folder FOLDER_ID] --revision REVISION_ID [--draft]
                  (--preview | --base-copy PUBLISHED_ID|none --attachments all|none|ID,...
                               [--permission-version N])
  page history PAGE_ID
  page download-attachment PAGE_ID ATTACHMENT_ID --out PATH|- [--draft] [--revision REVISION_ID]

The usual loop, with --json:
  spaces list                         space IDs, and the folder IDs shared with this agent
  tree --space S                      page IDs, each with its draftHead and publishedHead
  page read P --draft                 the draft, and its revisionId: the draft head
  page draft P --base D --file -      D is that draft head; prints the new draft head
  page attach P --file F              adds a file on top of the draft head, making a
                                      new draft head: use the revisionId it prints next
  page publish P --revision D --base-published B --permission-version N
                                      D the draft head, B the published head, or none,
                                      and N the permissionVersion page read showed
  Without --draft, page read gives the published version, whose revisionId is
  never a --base. When someone else wrote first (exit 3), --json names the
  current draftHead and publishedHead: read again from there.

Options for every command:
  --json                    machine-readable output, ASCII only. A failure is
                            printed to standard output too, as
                            {"error":{"exit":N,"code":"...","message":"...",...}}
  --passphrase-fd N         read the key file's passphrase from file descriptor N:
                            a file (3<file) or a pipe from a secret manager, never
                            a terminal. Don't write the passphrase itself in the
                            command (3<<<..., echo ... |): shell history keeps it
  --use-passphrase          ask for the passphrase even if a secret store is configured
  --idempotency-key KEY     for create, draft, attach and publish (see below)
  --help                    more about the command

${RETRYING}
IDs may start with - or --: one that is no option is taken as an ID where
one is wanted, and every word after a lone -- is an ID, as in
  wikistow page read --json -- --AbCdEfGhIjKlMnOpQrSt

Secrets are never read from arguments or the environment.

Exit status: 0 done, 1 failed, 2 usage, 3 conflict, 4 not found, 5 locked,
6 credential revoked, 7 missing keys, 8 trust failure (possibly an attack:
stop and tell this agent's person), 9 done, so don't run it again, but
what the run learned couldn't be saved locally ("warning" in --json): fix
that before going on.
`;

const LINKS = `Each wikilink is reported, as saved, with how it resolves among the pages
this agent can see: [[Title]], [[Folder/Title]], [[Title#Heading]],
[[#Heading]] (this page), [[Title|shown text]], and ![[file.png]], which
embeds an attachment of this page by its name. An embed is "missing" until
the file is attached (page attach) and the page drafted again. A saved page
remembers which page each link names, so a link follows its page through a
rename: when that page is published under a new title, the save writes it
into a link without its own text ([[Old]] becomes [[New]]; nothing else
changes) and reports it as "renamed": [{"from": "Old", "to": "New"}] in
--json. Read the page again before editing a local copy; a copy from before
the rename still names the page when sent on top of the draft that renamed
it. If the links can't be read (Markdown nested thousands deep), the page is
still saved, with exit status 0: the output says so, and links is null in
--json. YAML frontmatter is kept byte for byte and ignored; --title sets the
title.`;

const FILE = `--file PATH reads the Markdown from PATH, or from standard input for -.
It must be UTF-8, and is kept byte for byte, line ends included. A page holds
at most ${kilobytes(pageRoutes.MAX_MARKDOWN_BYTES)} of it: more exits 2 (too-large), and nothing changes.`;

/** Each command's own help. */
export const COMMAND_HELP = {
  'agent enroll': `Usage: wikistow agent enroll --server URL [--secret-store [--secret-tool PATH]]
                           [--fingerprint-answer-from-stdin]

Enroll this CLI as an agent of a WikiStow person. It prints a lookup code;
the person enters it under Agents in WikiStow. Both then show the same
fingerprint: type yes only if they match. Once the person approves, the
agent's keys and token are kept in ~/.config/wikistow/agent.key, under a
new passphrase of at least 12 characters (asked twice, or --passphrase-fd).

--server URL       https, or plain http only to this machine
--secret-store     also keep an unlock secret in the desktop's Secret Service
                   (libsecret's secret-tool), so later runs need no
                   passphrase. It needs a session bus and an unlocked keyring:
                   not cron or systemd on a machine nobody is logged in to.
--secret-tool PATH secret-tool somewhere other than /usr/bin/secret-tool. It,
                   and every directory above it, must be root's and writable
                   by nobody else: the CLI runs it before it can check anything
--fingerprint-answer-from-stdin
                   take the yes from standard input when it isn't a terminal.
                   Only for a person who compares the fingerprint and types
                   the answer through a pipe: a program must never answer it

While it runs, the CLI holds the agent's keys in memory, and a crash could
write them to a core dump. Where others could read one, turn them off for
the CLI: ulimit -c 0 in its shell, or LimitCORE=0 in its systemd unit.

To enroll again, move the whole ~/.config/wikistow directory away first.
`,
  'agent status': `Usage: wikistow agent status

Who this agent is, checked with the server: its name, its person, its
shares and how it unlocks.
`,
  whoami: `Usage: wikistow whoami

The same as agent status.
`,
  'agent secret-store': `Usage: wikistow agent secret-store enable|disable [--secret-tool PATH]

enable keeps an unlock secret in the Secret Service (asking for the
passphrase first); disable removes it, so only the passphrase unlocks the
agent. See agent enroll --help.
`,
  skill: `Usage: wikistow skill

Print a skill for this agent's harness: a SKILL.md in the Agent Skills
format. It tells the agent to leave changes as drafts unless its person
asks for them to be published, to put new pages in the person's Personal
space, and to read this help for the rest. Write it to a folder named
wikistow where the harness looks for skills, for example:
  mkdir -p ~/.claude/skills/wikistow
  wikistow skill > ~/.claude/skills/wikistow/SKILL.md
Edit that copy to change what it says. It names the version that printed
it: print it again after an update. With --json: {"skill":"..."}
`,
  'spaces list': `Usage: wikistow spaces list

Each share this agent was given: its space ID, the folder ID it starts at
(null for a whole space), the role, whether it may publish, and its name.
`,
  tree: `Usage: wikistow tree --space SPACE_ID

The folders and pages this agent can see in the space. With --json, each
page lists its id, title, permissionVersion, draftHead (null for readers)
and publishedHead (null until it is published).
`,
  search: `Usage: wikistow search QUERY [--space SPACE_ID]

The pages this agent can read whose title or text holds every word of
QUERY, best first; the last word also matches the start of a longer one.
Case and accents don't matter. Each page is searched as page read would
show it: the draft if this agent edits the page, the published version
otherwise. --space searches only that space. With --json:
  {"results":[{"pageId":"...","spaceId":"...","title":"...","draft":false,
               "unpublished":false,"snippet":"...","score":1.234}]}
draft is true when the text matched is a draft readers don't see (read it
with page read --draft). unpublished is true for a copy unpublished where
it is: readers see none of it, and the text matched is its last
publication. No match is not a failure: results is empty. Without --json,
one line per page: its ID, title, [draft] or [unpublished], and snippet.
Quote a QUERY of several words; put one that starts with -- after a lone --.
`,
  export: `Usage: wikistow export --out DIR [--space SPACE_ID] [--folder FOLDER_ID]

Write every page this agent can read as Markdown files in DIR, which must
be empty or not exist yet, and open to you alone (mode 700). Each page is
written as page read would show it: the draft if this agent edits the
page, the published version otherwise. --space exports one space,
--folder one folder and what is in it (--space saves looking up which
space); without either, each space goes in a folder of its own, named
after it.

Each page is one .md file, named after its title, in folders that mirror
the tree; its frontmatter and line ends are kept byte for byte. Each
page's attachments go in attachments/ at the top of its space. Wikilinks
name the files written, keeping their #heading and |text, so DIR opens as
an Obsidian vault; embeds and attachment: links get the attachment's
relative path. A link to a page that is missing, ambiguous or not
exported stays as written. A name no file system takes (a / or :, a
reserved name like CON, one too long) is changed, a name used twice in a
folder gets (2), and a link to a renamed file keeps the title as its text.

Folders are made mode 700 and files 600, and nothing already there is
written over or followed. If the export fails, what it wrote is removed.
With --json:
  {"out":"DIR","pages":[{"spaceId":"...","pageId":"...","path":"..."}],
   "attachments":[{"spaceId":"...","pageId":"...","attachmentId":"...","path":"..."}],
   "skipped":[{"spaceId":"...","pageId":"..."},
     {"spaceId":"...","pageId":"...","attachmentId":"...","path":"...",
      "reason":"missing|unreadable"}],
   "unread":[{"spaceId":"...","pageId":"...","path":"..."}]}
paths are relative to DIR, with / between folders. skipped lists pages
whose version couldn't be opened, and attachments the server has no file
for (missing) or that couldn't be opened (unreadable), so were left out.
unread lists pages written as they were, their links not rewritten,
because their Markdown couldn't be read (nested past the parser's stack).
A left-out attachment's path is where it would have been: its page's
links still name it there. A lost connection, an expired session or a
server error fails the export instead.
`,
  'page read': `Usage: wikistow page read PAGE_ID [--draft] [--revision REVISION_ID]

One version's title, Markdown and attachments. Without --draft, the
published version: exit 4 with code "unpublished" if there is none. With
--draft, the draft. --revision reads an earlier version of the same kind.
With --json, revisionId is the version read, and heads are the page's
current draftHead and publishedHead: --base for page draft is the draftHead.
permissionVersion changes whenever who can read the page changes: give it
to page publish to publish only to the readers there were when you looked.
Without --json, the Markdown alone is printed.
`,
  'page create': `Usage: wikistow page create --folder FOLDER_ID --title TITLE --file PATH|- [--space SPACE_ID]

A new page in a folder this agent may edit, with the Markdown as its first
draft. Prints the page ID and its draft head. --space saves looking up
which space the folder is in.

${FILE}

${LINKS}

${RETRYING}`,
  'page draft': `Usage: wikistow page draft PAGE_ID --base REVISION_ID --file PATH|- [--title TITLE]

Replace the draft's whole Markdown (and its title, with --title), keeping
its attachments. --base is the current draft head: the heads.draftHead of
page read --json, or the revisionId the last draft or attach printed. If
someone else saved since, nothing is overwritten: exit 3, with the current
heads. Prints the new draft head.

${FILE}

${LINKS}

${RETRYING}`,
  'page attach': `Usage: wikistow page attach PAGE_ID --file PATH|- [--name NAME] [--media-type TYPE] [--base REVISION_ID]

Encrypt and upload a file, and list it on a new draft on top of the draft
head (or --base, which must be the draft head). Prints the attachment and
the new draft head, which the next draft or publish must use. To embed the
file, then draft the page with ![[NAME]]. --name is needed with --file -.
The media type is guessed from the name's extension otherwise.

Like page draft, the new draft may write a page's new title into a link
and report it in "renamed". If the space's tree can't be loaded to check
the links, the file is still attached, the links are left as they were,
and "linksKept" is true in --json. So it is on a retry of a run by a CLI
from before link tables, which didn't check them.

${RETRYING}`,
  'page publish': `Usage: wikistow page publish PAGE_ID --revision REVISION_ID --base-published PUBLISHED_ID|none
                             [--permission-version N]

Publish exactly the draft --revision names, in place of exactly the
publication --base-published names (none for the first one). --revision is
the draft head and --base-published the published head, as tree --json or
page read --json show them. If either has moved on, nothing is published:
exit 3, with the current heads. The agent's share must allow publishing,
and so must its person's.

--permission-version is the page's permissionVersion, as tree --json or
page read --json show it. If who can read the page changed since (it was
shared, moved, or someone's access ended), nothing is published: exit 3,
with code "permission-version". Look again before deciding to publish.
Without it, the page is published to whoever can read it now.

${RETRYING}`,
  'page unpublish': `Usage: wikistow page unpublish PAGE_ID --base-published PUBLISHED_ID

Hide the page from its readers: they lose it and its published history.
Editors keep the draft and every version, and the next publish starts a
new history for readers. --base-published is the published head, as tree
--json or page read --json show it. If someone published since, nothing
is unpublished: exit 3, with the current heads. The agent's share must
allow publishing, and so must its person's.

Copies can't be recalled. Anyone who already read the page, or downloaded
it or its attachments, keeps what they have. Copies published to other
spaces stay there, for their readers.

If no answer came back, run it again as it was. If that publication was
the last one unpublished, it is done, and reported done again.
`,
  'page publish-to': `Usage: wikistow page publish-to PAGE_ID --space SPACE_ID [--folder FOLDER_ID]
                                --revision REVISION_ID [--draft]
                                (--preview | --base-copy PUBLISHED_ID|none
                                             --attachments all|none|ID,...
                                             [--permission-version N])

Copy one version of a page into another space, as a published version
there. Readers there see only what is copied, never this page's drafts or
other versions, and they get no access to this page. Later changes reach
the copy only when it is published to again.

--revision is the version to copy: the published head, or with --draft
the draft head (or an earlier version of the same kind). A draft copied
there is published there, though readers here haven't seen it.
--space is where it goes, and --folder the folder there (the top of the
space without it). If the page was published into that space before, the
next version goes to that copy, wherever it is now, and --folder must
name where that is: the preview's "parentId", or no --folder when that
is null.

--preview works it out and sends nothing. It prints where the copy goes
(--json: "state" is "new", "pending" for one opened and never finished, or
"existing", with its "pageId"), the copy's "publishedHead" there, the
"baseCopy" and "permissionVersion" to publish with, its "region" ("owner"
where only the space's owners read it, "share" where a share's members
do), every
attachment the version lists, and the "links" readers there may not be
able to open: wikilinks, and links to pages of other spaces. The pages
they point at aren't published with it. links is null when they couldn't
be read.

To publish, give --base-copy, the baseCopy --preview shows: the copy's
published head there, its latest publication if it is unpublished there,
or none when there is no copy there yet. And give --attachments: all,
none, or the IDs of the ones to copy, between commas. Each is copied and
encrypted afresh for that space; the rest are left out. If --base-copy
or --folder doesn't match, nothing is published: exit 3, naming the
copy's pageId, parentId, publishedHead and baseCopy. So is anything
someone does there while it is sent (exit 3 with the heads, or code
"permission-version" when access there changed): look again with
--preview.

Give --permission-version too, the permissionVersion --preview shows. If
who can read it there changed since that preview (a share, a move,
someone's access ended), nothing is published: exit 3, with code
"permission-version". This agent can't see who reads it there, so this is
how it holds the copy to the readers there were when it looked. Without
it, the copy goes to whoever can read it there now.

The agent may publish only where its shares and its person both allow it,
at this page and where the copy goes. A page already published into that
space, somewhere this agent can't publish, is refused with code
"published-elsewhere": someone who can publish the page can end that
copy's link to it in WikiStow first.

Copies can't be recalled. Once it is published there, anyone who can read
it there can keep what they read or download.

If no answer came back, run it again as it was. If the first run's copy
landed, --base-copy no longer matches, so it is refused with exit 3, and
"sameVersion" is true when the copy's published head says it is a copy
of this same version, with its title and text. That is the word of
whoever published it there, which nothing checks.
`,
  'page download-attachment': `Usage: wikistow page download-attachment PAGE_ID ATTACHMENT_ID --out PATH|- [--draft] [--revision REVISION_ID]

Decrypt one attachment of a version and write it to PATH, which must not
exist yet, or to standard output for - (not a terminal, and not with
--json). The version is chosen as page read chooses it: the published one,
the draft with --draft, or --revision. Attachment IDs are listed under
attachments by page read --json.
`,
  'page history': `Usage: wikistow page history PAGE_ID

The published versions, newest first, and who published each.
`,
} as const satisfies Record<CommandName, string>;
