// Keeps the project board in step with the repo (docs/project-board.md).
//
//   node scripts/board.ts setup                         adds the fields, label and views below; a second run changes nothing
//   node scripts/board.ts add <title> --body-file F --area A… [--low] [--no-area] [--release V|--later]
//   node scripts/board.ts ask <title> --body-file F --waiting decide|try|do --next "…" [--area A…] [--release V|--later]
//   node scripts/board.ts plan <#n> <version>|later      moves it to that release's milestone
//   node scripts/board.ts ship <version>                closes the milestone once v<version> is tagged
//   node scripts/board.ts start <#n>                    In Progress
//   node scripts/board.ts wait <#n> decide|try|do|outside --next "…"   or   wait <#n> --clear
//   node scripts/board.ts drop <#n> --why "…" [--duplicate-of M]       closes it as not planned, then Dropped
//   node scripts/board.ts set <#n> Field=Value…         any field but Priority; Field= clears it
//   node scripts/board.ts list [--waiting] [--area A] [--release V|--later]
//   node scripts/board.ts check                         problems exit 1; notes only warn
//
// Each issue's release is its GitHub milestone, named for the version, such as
// 0.33.0, or Later. Without --release or --later, add and ask file into the
// next minor version after the newest tag.
//
// It needs `gh` signed in with the `project` scope (`gh auth refresh -s project`).
// Every run looks up the board's IDs by name, so nothing here or in the docs
// names an ID.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const OWNER = 'skint007';
const NUMBER = 2;
const REPO = 'skint007/wikistow';

type Color = 'GRAY' | 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'PINK' | 'PURPLE';
type OptionSpec = { name: string; color: Color; description: string };

/** Options setup adds to the board's own Status field. Its other options stay as they are. */
const STATUS_OPTIONS: OptionSpec[] = [
  {
    name: 'Dropped',
    color: 'GRAY',
    description: 'We chose not to build it; the issue’s last comment says why',
  },
];

/** Fields setup creates. A select field that exists only gains the options it lacks. */
const FIELDS: { name: string; options?: OptionSpec[] }[] = [
  {
    name: 'Waiting',
    options: [
      { name: 'Scott: decide', color: 'RED', description: 'Scott chooses; Next step says what' },
      {
        name: 'Scott: try it',
        color: 'ORANGE',
        description: 'Scott tries it; Next step says what and where',
      },
      {
        name: 'Scott: do it',
        color: 'YELLOW',
        description: 'Accounts, certificates, browser-only settings, his hardware',
      },
      {
        name: 'Outside',
        color: 'GRAY',
        description: 'A store review, an upstream fix or a certificate authority',
      },
    ],
  },
  { name: 'Next step' },
];

/** `wait`'s and `ask`'s short names for the Waiting options. */
const WAITING: Record<string, string> = {
  decide: 'Scott: decide',
  try: 'Scott: try it',
  do: 'Scott: do it',
  outside: 'Outside',
};

const LABELS = [
  { name: 'low', color: 'c5def5', description: 'A Low review finding with an issue of its own' },
];

/** Views setup creates, or whose filter it sets. Columns are set only on a view it creates. */
const VIEWS: {
  name: string;
  /** A view of this name is renamed to `name`, when no view has `name` yet. */
  was?: string;
  layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT';
  filter: string;
  fields?: string[];
}[] = [
  { name: 'Board', layout: 'BOARD_LAYOUT', filter: '-label:low -status:Dropped' },
  {
    name: 'Waiting',
    layout: 'TABLE_LAYOUT',
    filter: 'is:open is:issue has:waiting',
    fields: ['Title', 'Waiting', 'Next step', 'Priority', 'Labels'],
  },
  {
    name: 'Lows',
    layout: 'TABLE_LAYOUT',
    filter: 'is:open label:low',
    fields: ['Title', 'Labels', 'Status'],
  },
  {
    name: 'By release',
    was: 'Milestones',
    layout: 'TABLE_LAYOUT',
    filter: 'is:open is:issue',
    fields: ['Title', 'Milestone', 'Status', 'Priority', 'Labels'],
  },
];

/** The milestone for work not given a version yet. */
const LATER = 'Later';

const say = (text: string) => process.stdout.write(`${text}\n`);
const PRIORITY_ORDER = ['P0', 'P1', 'P2'];
const root = fileURLToPath(new URL('..', import.meta.url));

// --- GitHub -----------------------------------------------------------------

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function graphql<T>(query: string, variables: Record<string, unknown> = {}): T {
  const out = JSON.parse(
    gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })),
  );
  if (out.errors) throw new Error(out.errors.map((e: { message: string }) => e.message).join('\n'));
  return out.data;
}

type Option = { id: string; name: string; color: Color; description: string };
type Field = { id: string; name: string; dataType: string; options?: Option[] };
type View = { id: string; name: string; layout: string; filter: string | null };
type Project = { id: string; fields: Field[]; views: View[] };

let project: Project | undefined;
function loadProject(): Project {
  if (project) return project;
  const data = graphql<{
    user: { projectV2: { id: string; fields: { nodes: Field[] }; views: { nodes: View[] } } };
  }>(
    `
      query ($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  options {
                    id
                    name
                    color
                    description
                  }
                }
              }
            }
            views(first: 50) {
              nodes {
                id
                name
                layout
                filter
              }
            }
          }
        }
      }
    `,
    { owner: OWNER, number: NUMBER },
  );
  const p = data.user.projectV2;
  project = { id: p.id, fields: p.fields.nodes, views: p.views.nodes };
  return project;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function field(name: string): Field {
  const found = loadProject().fields.find((f) => same(f.name, name));
  if (!found) fail([`The board has no field “${name}”. Run setup first.`]);
  return found;
}

function option(f: Field, name: string): Option {
  const found = f.options?.find((o) => same(o.name, name));
  if (!found)
    fail([`${f.name} has no option “${name}”: ${f.options?.map((o) => o.name).join(', ')}`]);
  return found;
}

type Item = {
  id: string;
  type: string;
  status?: { name: string; updatedAt: string };
  priority?: { name: string };
  waiting?: { name: string };
  next?: { text: string };
  content: {
    __typename: 'Issue' | 'PullRequest' | 'DraftIssue';
    number?: number;
    title: string;
    state?: 'OPEN' | 'CLOSED' | 'MERGED';
    stateReason?: 'COMPLETED' | 'NOT_PLANNED' | 'DUPLICATE' | 'REOPENED' | null;
    labels?: { nodes: { name: string }[] };
    milestone?: { title: string } | null;
    comments?: { nodes: { body: string }[] };
  } | null;
};

/** Every item on the board, page by page (the API gives at most 100 at a time). */
function items(): Item[] {
  const all: Item[] = [];
  let after: string | null = null;
  for (;;) {
    const data: {
      user: {
        projectV2: {
          items: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Item[] };
        };
      };
    } = graphql(
      `
        query ($owner: String!, $number: Int!, $after: String) {
          user(login: $owner) {
            projectV2(number: $number) {
              items(first: 100, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  type
                  status: fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      updatedAt
                    }
                  }
                  priority: fieldValueByName(name: "Priority") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                  waiting: fieldValueByName(name: "Waiting") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                  next: fieldValueByName(name: "Next step") {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                    }
                  }
                  content {
                    __typename
                    ... on Issue {
                      number
                      title
                      state
                      stateReason
                      labels(first: 20) {
                        nodes {
                          name
                        }
                      }
                      milestone {
                        title
                      }
                      comments(last: 3) {
                        nodes {
                          body
                        }
                      }
                    }
                    ... on PullRequest {
                      number
                      title
                      state
                    }
                    ... on DraftIssue {
                      title
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner: OWNER, number: NUMBER, after },
    );
    const page = data.user.projectV2.items;
    all.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return all;
    after = page.pageInfo.endCursor;
  }
}

/** The board's item for an issue or PR, or undefined when it isn't on the board. */
function findItem(number: number): { item: string | undefined; content: string } {
  const data = graphql<{
    repository: {
      issueOrPullRequest: {
        id: string;
        projectItems: { nodes: { id: string; project: { number: number } }[] };
      } | null;
    };
  }>(
    `
      query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issueOrPullRequest(number: $number) {
            ... on Issue {
              id
              projectItems(first: 20) {
                nodes {
                  id
                  project {
                    number
                  }
                }
              }
            }
            ... on PullRequest {
              id
              projectItems(first: 20) {
                nodes {
                  id
                  project {
                    number
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner: OWNER, name: REPO.split('/')[1], number },
  );
  const found = data.repository.issueOrPullRequest;
  if (!found) fail([`#${number} isn't an issue or PR of ${REPO}.`]);
  return {
    item: found.projectItems.nodes.find((n) => n.project.number === NUMBER)?.id,
    content: found.id,
  };
}

/**
 * The issue's or PR's item, adding it to the board if it isn't there. The
 * board's auto-add may add a new issue at the same moment, and then adding
 * fails as already there, so look again.
 */
function itemId(number: number): string {
  const { item, content } = findItem(number);
  if (item) return item;
  try {
    const data = graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `
        mutation ($project: ID!, $content: ID!) {
          addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
            item {
              id
            }
          }
        }
      `,
      { project: loadProject().id, content },
    );
    return data.addProjectV2ItemById.item.id;
  } catch (error) {
    const again = findItem(number).item;
    if (again) return again;
    throw error;
  }
}

/** Sets a field by name: an option's name for a select, text otherwise. An empty value clears it. */
function setField(item: string, name: string, value: string) {
  const f = field(name);
  const ids = { project: loadProject().id, item, field: f.id };
  if (value === '') {
    graphql(
      `
        mutation ($project: ID!, $item: ID!, $field: ID!) {
          clearProjectV2ItemFieldValue(
            input: { projectId: $project, itemId: $item, fieldId: $field }
          ) {
            clientMutationId
          }
        }
      `,
      ids,
    );
    return;
  }
  const v = f.options ? { singleSelectOptionId: option(f, value).id } : { text: value };
  graphql(
    `
      mutation ($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(
          input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }
        ) {
          clientMutationId
        }
      }
    `,
    { ...ids, value: v },
  );
}

function statusOf(item: string): string | undefined {
  const data = graphql<{ node: { status: { name: string } | null } }>(
    `
      query ($item: ID!) {
        node(id: $item) {
          ... on ProjectV2Item {
            status: fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
          }
        }
      }
    `,
    { item },
  );
  return data.node.status?.name;
}

// --- setup ------------------------------------------------------------------

/** Sends the whole option list back, existing options with their IDs, so no card loses its value. */
function addOptions(f: Field, wanted: OptionSpec[], changes: string[]) {
  const missing = wanted.filter((w) => !f.options?.some((o) => same(o.name, w.name)));
  if (missing.length === 0) return;
  const before = f.options ?? [];
  const options = [
    ...before.map(({ id, name, color, description }) => ({ id, name, color, description })),
    ...missing,
  ];
  const data = graphql<{ updateProjectV2Field: { projectV2Field: { options: Option[] } } }>(
    `
      mutation ($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
        updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) {
          projectV2Field {
            ... on ProjectV2SingleSelectField {
              options {
                id
                name
                color
                description
              }
            }
          }
        }
      }
    `,
    { field: f.id, options },
  );
  const after = data.updateProjectV2Field.projectV2Field.options;
  const lost = before.filter((o) => !after.some((a) => a.id === o.id));
  if (lost.length)
    fail([`${f.name}: options changed ID: ${lost.map((o) => `${o.name} ${o.id}`).join(', ')}`]);
  f.options = after;
  changes.push(`${f.name}: added ${missing.map((m) => m.name).join(', ')}`);
}

function setup() {
  const p = loadProject();
  const changes: string[] = [];

  addOptions(field('Status'), STATUS_OPTIONS, changes);

  for (const spec of FIELDS) {
    const existing = p.fields.find((f) => same(f.name, spec.name));
    if (existing) {
      if (spec.options) addOptions(existing, spec.options, changes);
      continue;
    }
    const data = graphql<{ createProjectV2Field: { projectV2Field: Field } }>(
      `
        mutation (
          $project: ID!
          $name: String!
          $type: ProjectV2CustomFieldType!
          $options: [ProjectV2SingleSelectFieldOptionInput!]
        ) {
          createProjectV2Field(
            input: {
              projectId: $project
              name: $name
              dataType: $type
              singleSelectOptions: $options
            }
          ) {
            projectV2Field {
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                options {
                  id
                  name
                  color
                  description
                }
              }
            }
          }
        }
      `,
      {
        project: p.id,
        name: spec.name,
        type: spec.options ? 'SINGLE_SELECT' : 'TEXT',
        options: spec.options,
      },
    );
    p.fields.push(data.createProjectV2Field.projectV2Field);
    changes.push(`field ${spec.name}: created`);
  }

  const labels: { name: string }[] = JSON.parse(
    gh(['label', 'list', '--repo', REPO, '--limit', '200', '--json', 'name']),
  );
  for (const label of LABELS) {
    if (labels.some((l) => same(l.name, label.name))) continue;
    gh([
      'label',
      'create',
      label.name,
      '--repo',
      REPO,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
    changes.push(`label ${label.name}: created`);
  }

  for (const spec of VIEWS) {
    let view = p.views.find((v) => same(v.name, spec.name));
    const old = spec.was && !view ? p.views.find((v) => same(v.name, spec.was!)) : undefined;
    if (old) {
      graphql(
        `
          mutation ($view: ID!, $name: String!) {
            updateProjectV2View(input: { viewId: $view, name: $name }) {
              clientMutationId
            }
          }
        `,
        { view: old.id, name: spec.name },
      );
      changes.push(`view ${old.name}: renamed ${spec.name}`);
      old.name = spec.name;
      view = old;
    }
    if (!view) {
      const data = graphql<{ createProjectV2View: { projectV2View: View } }>(
        `
          mutation ($project: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $fields: [ID!]) {
            createProjectV2View(
              input: {
                projectId: $project
                name: $name
                layout: $layout
                configuration: { visibleFieldIds: $fields }
              }
            ) {
              projectV2View {
                id
                name
                layout
                filter
              }
            }
          }
        `,
        {
          project: p.id,
          name: spec.name,
          layout: spec.layout,
          fields: spec.fields?.map((name) => field(name).id),
        },
      );
      view = data.createProjectV2View.projectV2View;
      p.views.push(view);
      changes.push(`view ${spec.name}: created`);
    }
    if (view.filter !== spec.filter) {
      graphql(
        `
          mutation ($view: ID!, $filter: String!) {
            updateProjectV2View(input: { viewId: $view, filter: $filter }) {
              clientMutationId
            }
          }
        `,
        { view: view.id, filter: spec.filter },
      );
      view.filter = spec.filter;
      changes.push(`view ${spec.name}: filter ${spec.filter}`);
    }
  }

  say(changes.length ? changes.join('\n') : 'Nothing to change.');
}

// --- releases ---------------------------------------------------------------

type Version = [number, number, number];
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

type Tag = { version: Version; beta: boolean };
let tagList: Tag[] | undefined;
/** The repo's release tags, read from GitHub so a stale checkout can't pick an old version. */
function tags(): Tag[] {
  tagList ??= gh(['api', '--paginate', `repos/${REPO}/git/matching-refs/tags/v`, '--jq', '.[].ref'])
    .split('\n')
    .flatMap((ref) => {
      const m = /^refs\/tags\/v(\d+\.\d+\.\d+)(-.+)?$/.exec(ref.trim());
      const version = m && parseVersion(m[1]!);
      return version ? [{ version, beta: !!m[2] }] : [];
    });
  return tagList;
}

const highest = (list: Tag[]) =>
  list.map((t) => t.version).sort((a, b) => compare(b, a))[0] as Version | undefined;

/** The version a new issue ships in by default: the minor after the newest tag, beta or not. */
function nextRelease(): string {
  const top = highest(tags());
  if (!top) fail(['No v* tags on GitHub: give --release or --later.']);
  return `${top[0]}.${top[1] + 1}.0`;
}

type Milestone = { number: number; title: string; state: 'open' | 'closed'; open_issues: number };
let milestoneList: Milestone[] | undefined;
function milestones(): Milestone[] {
  milestoneList ??= gh([
    'api',
    '--paginate',
    `repos/${REPO}/milestones?state=all&per_page=100`,
    '--jq',
    '.[] | {number, title, state, open_issues}',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Milestone);
  return milestoneList;
}

/** `0.33.0`, `v0.33.0` or `later` as a milestone title, or undefined when it is neither. */
function releaseName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (same(text, LATER)) return LATER;
  const v = parseVersion(text);
  return v && v.join('.');
}

/** The open milestone for a release, created when there is none; a shipped release is refused. */
function openRelease(text: string): string {
  const title = releaseName(text);
  if (!title) fail([`A release is a version, such as 0.33.0, or later; not “${text}”.`]);
  const found = milestones().find((m) => same(m.title, title));
  if (found?.state === 'closed')
    fail([`${title}’s milestone is closed, so it has shipped. Pick a later release.`]);
  if (found) return found.title;
  const v = parseVersion(title);
  const stable = highest(tags().filter((t) => !t.beta));
  if (v && stable && compare(v, stable) <= 0)
    fail([
      `v${title} isn't after v${stable.join('.')}, the newest stable release. Pick a later one.`,
    ]);
  const made = JSON.parse(
    gh([
      'api',
      '-X',
      'POST',
      `repos/${REPO}/milestones`,
      '-f',
      `title=${title}`,
      '-f',
      `description=${title === LATER ? 'Not planned for a release yet' : `What ships in ${title}`}`,
    ]),
  ) as Milestone;
  milestones().push({ ...made, open_issues: 0 });
  say(`Milestone ${title}: created`);
  return title;
}

/** `--release V` or `--later`, else the next release. */
function chosenRelease(release: string | undefined, later: boolean | undefined): string {
  if (release && later) fail(['Give --release or --later, not both.']);
  return openRelease(later ? LATER : (release ?? nextRelease()));
}

function plan(number: number, release: string | undefined) {
  if (!release) fail(['Give the release: a version, such as 0.33.0, or later.']);
  const title = openRelease(release);
  gh(['issue', 'edit', String(number), '--repo', REPO, '--milestone', title]);
  say(`#${number} in ${title}.`);
}

/** Closes a shipped version's milestone. Open issues in it must move first. */
function ship(release: string | undefined) {
  const title = releaseName(release);
  const v = title && parseVersion(title);
  if (!v) fail([`Give the version that shipped, such as 0.32.0, not “${release ?? ''}”.`]);
  if (!tags().some((t) => !t.beta && compare(t.version, v) === 0))
    fail([`v${title} isn't tagged on GitHub yet: tag it first.`]);
  const found = milestones().find((m) => same(m.title, title));
  if (!found) fail([`No milestone ${title}.`]);
  if (found.state === 'closed') return say(`${title} is closed already.`);
  const left: { number: number; title: string }[] = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      REPO,
      '--milestone',
      found.title,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title',
    ]),
  );
  if (left.length)
    fail([
      `${title} still has open issues. Move each with \`board plan <#n> <version>|later\`:`,
      ...left.map((i) => `  #${i.number} ${i.title}`),
    ]);
  gh(['api', '-X', 'PATCH', `repos/${REPO}/milestones/${found.number}`, '-f', 'state=closed']);
  say(`${title} closed.`);
}

// --- commands ---------------------------------------------------------------

function issueNumber(arg: string | undefined): number {
  const n = Number(arg?.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0)
    fail([`Expected an issue number, such as #123, not “${arg ?? ''}”.`]);
  return n;
}

/** `search` or `area: search` becomes the repo's `area: search` label. */
function areaLabels(areas: string[]): string[] {
  const known: { name: string }[] = JSON.parse(
    gh(['label', 'list', '--repo', REPO, '--search', 'area:', '--limit', '100', '--json', 'name']),
  );
  return areas.map((a) => {
    const name = a.startsWith('area:') ? a : `area: ${a}`;
    const label = known.find((k) => same(k.name, name));
    if (!label)
      fail([`No label “${name}”. Areas: ${known.map((k) => k.name.slice(6)).join(', ')}`]);
    return label.name;
  });
}

function fileIssue(
  title: string,
  bodyFile: string | undefined,
  labels: string[],
  release: string,
): number {
  if (!bodyFile) fail(['--body-file is required.']);
  const url = gh([
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    title,
    '--body-file',
    bodyFile,
    ...labels.flatMap((l) => ['--label', l]),
    '--milestone',
    release,
  ]).trim();
  const number = Number(url.split('/').pop());
  // Said first, so a failure below still shows the issue was filed.
  say(`${url}  ${release}`);
  itemId(number);
  return number;
}

function waiting(kind: string | boolean | undefined): string {
  const name = typeof kind === 'string' ? WAITING[kind.toLowerCase()] : undefined;
  if (!name) fail([`Waiting is one of ${Object.keys(WAITING).join(', ')}, not “${kind ?? ''}”.`]);
  return name;
}

async function drop(number: number, why: string | undefined, duplicateOf: string | undefined) {
  if (!why) fail(['--why is required: the reason goes in the issue’s last comment.']);
  const item = itemId(number);
  const close = duplicateOf ? ['--duplicate-of', duplicateOf] : ['--reason', 'not planned'];
  gh(['issue', 'close', String(number), '--repo', REPO, ...close, '--comment', `Dropped: ${why}`]);
  // The board's "Item closed" workflow sets Done a moment after the close, not
  // planned or not. Wait for it, so it can't overwrite Dropped afterwards.
  for (let i = 0; i < 15 && statusOf(item) !== 'Done'; i++)
    await new Promise((r) => setTimeout(r, 2000));
  setField(item, 'Status', 'Dropped');
  setField(item, 'Waiting', '');
  setField(item, 'Next step', '');
  say(`#${number} Dropped.`);
}

/** Release order: versions oldest first, then Later, then no release. */
function releaseOrder(a: string | undefined, b: string | undefined): number {
  const key = (t: string | undefined) =>
    t === undefined ? 2 : same(t, LATER) ? 1 : parseVersion(t) ? 0 : 1;
  const va = a ? parseVersion(a) : undefined;
  const vb = b ? parseVersion(b) : undefined;
  return key(a) - key(b) || (va && vb ? compare(va, vb) : 0);
}

function list(onlyWaiting: boolean, area: string | undefined, release: string | undefined) {
  const rank = (i: Item) => {
    const p = PRIORITY_ORDER.indexOf(i.priority?.name ?? '');
    return p < 0 ? PRIORITY_ORDER.length : p;
  };
  const shown = release && releaseName(release);
  if (release && !shown)
    fail([`A release is a version, such as 0.33.0, or later; not “${release}”.`]);
  const open = items()
    .filter((i) => i.content?.__typename !== 'PullRequest' && i.content?.state !== 'CLOSED')
    .filter((i) => !onlyWaiting || i.waiting)
    .filter(
      (i) =>
        !area ||
        i.content?.labels?.nodes.some((l) => same(l.name, `area: ${area}`) || same(l.name, area)),
    )
    .filter((i) => !shown || same(i.content?.milestone?.title ?? '', shown))
    .sort(
      (a, b) =>
        releaseOrder(a.content?.milestone?.title, b.content?.milestone?.title) ||
        rank(a) - rank(b) ||
        (a.content?.number ?? 0) - (b.content?.number ?? 0),
    );
  for (const i of open) {
    const c = i.content!;
    const labels = c.labels?.nodes.map((l) => l.name.replace(/^area: /, '')).join(', ');
    say(
      [
        c.number ? `#${c.number}` : 'draft',
        c.milestone?.title ?? 'no release',
        i.status?.name ?? '-',
        i.priority?.name ?? '-',
        i.waiting?.name ?? '',
        c.title,
        labels ? `[${labels}]` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
    if (i.next?.text) say(`      next: ${i.next.text}`);
  }
}

// --- check ------------------------------------------------------------------

async function check() {
  const problems: string[] = [];
  const notes: string[] = [];
  const board = items();
  const byNumber = new Map(
    board.filter((i) => i.content?.number).map((i) => [i.content!.number!, i]),
  );
  const json = (args: string[]) =>
    JSON.parse(gh(args)) as { number: number; body?: string; title?: string; state?: string }[];
  const openIssues = json([
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number,title',
  ]);
  const openPrs = json([
    'pr',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,body',
  ]);
  const names = (body: string | undefined, n: number) => new RegExp(`#${n}\\b`).test(body ?? '');
  const closes = (body: string | undefined, n: number) =>
    new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${n}\\b`, 'i').test(body ?? '');

  for (const issue of openIssues) {
    if (!byNumber.has(issue.number))
      problems.push(`#${issue.number} is open but not on the board: ${issue.title}`);
  }

  for (const i of board) {
    const c = i.content;
    if (!c) continue;
    if (c.__typename === 'DraftIssue') {
      notes.push(`Draft “${c.title}” on the board: file it as an issue.`);
      continue;
    }
    const n = c.number!;
    const status = i.status?.name;
    const closed = c.state !== 'OPEN';
    const dropped =
      c.__typename === 'Issue' &&
      (c.stateReason === 'NOT_PLANNED' || c.stateReason === 'DUPLICATE');
    const kind = c.__typename === 'Issue' ? 'Issue' : 'PR';

    if (!closed && (status === 'Done' || status === 'Dropped'))
      problems.push(`${kind} #${n} is open but ${status}.`);
    if (closed && kind === 'PR' && status !== 'Done' && status !== 'Dropped')
      problems.push(`PR #${n} is ${c.state!.toLowerCase()} but ${status ?? 'has no Status'}.`);
    if (closed && kind === 'Issue' && !dropped && status !== 'Done')
      problems.push(`#${n} closed as completed but ${status ?? 'has no Status'}.`);
    if (closed && dropped && status !== 'Dropped')
      problems.push(
        `#${n} closed as ${c.stateReason === 'DUPLICATE' ? 'a duplicate' : 'not planned'} but ${status ?? 'has no Status'}; set Dropped.`,
      );
    if (closed && i.waiting)
      problems.push(`${kind} #${n} is closed but still Waiting on ${i.waiting.name}.`);
    if (kind !== 'Issue' || closed) {
      if (
        dropped &&
        status === 'Dropped' &&
        !c.comments?.nodes.some((m) => m.body.startsWith('Dropped:'))
      )
        notes.push(`#${n} is Dropped with no “Dropped:” comment giving the reason.`);
      continue;
    }

    if (status === 'In Review' && !openPrs.some((p) => names(p.body, n)))
      problems.push(`#${n} is In Review, but no open PR names it.`);
    if (status === 'In Progress' && openPrs.some((p) => closes(p.body, n)))
      problems.push(`#${n} is In Progress, but an open PR closes it: In Review.`);
    if (
      status === 'In Progress' &&
      !openPrs.some((p) => names(p.body, n)) &&
      i.status &&
      Date.now() - Date.parse(i.status.updatedAt) > 3 * 86400_000
    )
      notes.push(`#${n} has been In Progress for over three days with no open PR.`);
    const labels = c.labels?.nodes.map((l) => l.name) ?? [];
    if (labels.includes('question') && !i.waiting)
      problems.push(`#${n} is a question with no Waiting.`);
    if (i.waiting && !i.next?.text)
      problems.push(`#${n} waits on ${i.waiting.name} with no Next step.`);
    if (!labels.some((l) => l.startsWith('area:')) && !labels.includes('question'))
      notes.push(`#${n} has no area: label.`);
    const release = c.milestone?.title;
    if (!release) problems.push(`#${n} has no release: \`board plan ${n} <version>|later\`.`);
    else if (milestones().find((m) => m.title === release)?.state === 'closed')
      problems.push(`#${n} is open in ${release}, which has shipped: move it with \`board plan\`.`);
  }

  const stable = highest(tags().filter((t) => !t.beta));
  for (const m of milestones()) {
    if (m.state !== 'open') continue;
    const v = parseVersion(m.title);
    if (!v && m.title !== LATER)
      problems.push(`Milestone “${m.title}” is open but isn't a version or ${LATER}.`);
    else if (v && stable && compare(v, stable) <= 0)
      problems.push(
        `${m.title} has shipped (v${stable.join('.')} is tagged): \`board ship ${m.title}\`.`,
      );
  }

  let newest = '';
  try {
    newest =
      execFileSync('git', ['tag', '-l', 'v*', '--sort=-creatordate'], {
        cwd: root,
        encoding: 'utf8',
      }).split('\n')[0] ?? '';
  } catch {
    // No git, or not a checkout: the note below says so.
  }
  if (!newest) notes.push('No v* tags in this checkout, so the beta question went unchecked.');
  else if (
    newest.includes('-') &&
    !openIssues.some(
      (o) =>
        o.title?.includes(newest.slice(1)) &&
        byNumber.get(o.number)?.content?.labels?.nodes.some((l) => l.name === 'question'),
    )
  )
    problems.push(`${newest} is a beta, and no open question asks whether it is good.`);

  for (const note of notes) say(`note: ${note}`);
  if (problems.length) fail(problems);
  say(`No problems${notes.length ? `, ${notes.length} notes` : ''}.`);
}

function fail(lines: string[]): never {
  process.stderr.write(lines.map((line) => `${line}\n`).join(''));
  process.exit(1);
}

// --- main -------------------------------------------------------------------

// `list --waiting` is a switch; `ask --waiting decide` takes a value.
const listing = process.argv[2] === 'list';
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'body-file': { type: 'string' },
    area: { type: 'string', multiple: true },
    low: { type: 'boolean' },
    'no-area': { type: 'boolean' },
    waiting: { type: listing ? 'boolean' : 'string' },
    next: { type: 'string' },
    clear: { type: 'boolean' },
    why: { type: 'string' },
    'duplicate-of': { type: 'string' },
    release: { type: 'string' },
    later: { type: 'boolean' },
  },
});
const [command, ...rest] = positionals;

switch (command) {
  case 'setup':
    setup();
    break;
  case 'add': {
    const areas = flags.area ?? [];
    if (!areas.length && !flags['no-area'])
      fail(['Give an --area, or --no-area and say why in your reply.']);
    fileIssue(
      rest.join(' '),
      flags['body-file'],
      [...areaLabels(areas), ...(flags.low ? ['low'] : [])],
      chosenRelease(flags.release, flags.later),
    );
    break;
  }
  case 'ask': {
    const name = waiting(flags.waiting);
    if (!flags.next) fail(['--next is required: one plain sentence saying what to do, and where.']);
    const number = fileIssue(
      rest.join(' '),
      flags['body-file'],
      ['question', ...areaLabels(flags.area ?? [])],
      chosenRelease(flags.release, flags.later),
    );
    const item = itemId(number);
    setField(item, 'Waiting', name);
    setField(item, 'Next step', flags.next);
    break;
  }
  case 'start':
    setField(itemId(issueNumber(rest[0])), 'Status', 'In Progress');
    break;
  case 'wait': {
    const item = itemId(issueNumber(rest[0]));
    if (flags.clear) {
      setField(item, 'Waiting', '');
      setField(item, 'Next step', '');
      break;
    }
    const name = waiting(rest[1]);
    if (!flags.next) fail(['--next is required: one plain sentence saying what to do, and where.']);
    setField(item, 'Waiting', name);
    setField(item, 'Next step', flags.next);
    break;
  }
  case 'drop':
    await drop(issueNumber(rest[0]), flags.why, flags['duplicate-of']);
    break;
  case 'set': {
    const item = itemId(issueNumber(rest[0]));
    for (const pair of rest.slice(1)) {
      const eq = pair.indexOf('=');
      if (eq < 0) fail([`Expected Field=Value, not “${pair}”.`]);
      const name = pair.slice(0, eq);
      if (same(name, 'Priority')) fail(['Priority is Scott’s to set.']);
      setField(item, field(name).name, pair.slice(eq + 1));
    }
    break;
  }
  case 'plan':
    plan(issueNumber(rest[0]), rest[1]);
    break;
  case 'ship':
    ship(rest[0]);
    break;
  case 'list':
    list(flags.waiting === true, flags.area?.[0], flags.later ? LATER : flags.release);
    break;
  case 'check':
    await check();
    break;
  default:
    fail([
      'Usage: node scripts/board.ts setup|add|ask|start|wait|drop|set|plan|ship|list|check (see the top of scripts/board.ts)',
    ]);
}
