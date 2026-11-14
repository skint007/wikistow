// One app's part in a page's live session (protocol section 5.10, ADR 0015
// decisions 4 to 7 and 12): joining it as its starter or as a newcomer,
// taking in everyone's messages with every check the section asks for,
// sending its own typing and presence, the saver's autosave of the shared
// document as draft revisions, and when its own typing counts as saved.
//
// Not here yet (ADR 0015 step 7): folding in drafts written outside the
// session, Review, offline resume and putting typing back by block. A
// draft from outside, a join that lapsed or a session this app can't catch
// up with makes it leave, and the editor goes on as a writer outside the
// session, with today's conflict and **Merge…**.
import {
  IdentityId,
  JoinId,
  LiveExtension,
  LIVE_NAMESPACE,
  OverlapEntry,
  overlapPart,
  OVERLAPS_NAMESPACE,
  OverlapsExtension,
  RevisionId,
  liveRoutes,
  type LiveMessage,
  type LivePresence,
  type PageId,
  type SpaceId,
} from '@wikistow/contracts';
import * as Y from 'yjs';
import { ApiError, outcomeUnknown } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { isAgentId } from '../identity.ts';
import { changePending, requireNotBehind } from '../key-versions.ts';
import { newId } from '../ids.ts';
import { LINKS_NAMESPACE, withoutLinkTable } from '../link-table.ts';
import type { ClientContext } from '../operations/session.ts';
import { checkPayloadSize, PageTooLarge, type PagePayload } from '../payload.ts';
import { sameRegion, type Region } from '../regions.ts';
import {
  decodeState,
  decodeUpdate,
  holdsState,
  sameState,
  type DecodedUpdate,
  type LiveState,
  type MapRoot,
  type TextRoot,
} from './decode.ts';
import { LiveDocument, samePayload } from './document.ts';
import { splitFrontmatter } from '../markdown/index.ts';
import {
  carryInto,
  foldPayloads,
  targetOf,
  namespacesOf,
  reviewMerge,
  reviewTarget,
  UNHELD_NAMESPACES,
  type FoldTarget,
  type Folded,
  type ReviewTarget,
} from './fold.ts';
import type { Choice, Merge } from '../merge/index.ts';
import { draftLive, sessionState, withLive } from './extension.ts';
import { LiveJoins, type JoinRef, type ListedJoin } from './joins.ts';
import {
  liveClientId,
  openLiveMessage,
  presenceContent,
  readPresence,
  readSaved,
  readSnapshot,
  sealLiveMessage,
  stateContent,
  type LiveBinding,
  type OpenedLiveMessage,
  type ReadPresence,
} from './messages.ts';
import {
  fetchPageSession,
  liveTransport,
  openServedSession,
  startPageSession,
  type LiveFetch,
  type LiveTransport,
} from './operations.ts';
import {
  liveBinding,
  requireLiveAccess,
  type LiveAccess,
  type OpenedLiveSession,
} from './session.ts';
import { openSnapshot } from './snapshot.ts';
import { changeText, changeTextByLines, textChanges } from './text-change.ts';

/** A draft of the page, opened. */
export type OpenedDraft = {
  revisionId: RevisionId;
  payload: PagePayload;
  authorId: IdentityId;
  /** The draft it was saved over, as its signed record says. */
  basedOn: RevisionId | null;
  region: Region;
  /** In a share, the key version it is under; null in the owner region. */
  keyVersion: number | null;
};

/** What a participant reaches outside itself: the app's own, or the tests'. */
export type ParticipantPorts = {
  ctx: ClientContext;
  page: { spaceId: SpaceId; pageId: PageId };
  /** Where the stream and leaving go. */
  live?: LiveFetch;
  /** Open a draft of the page, as the server has it now. */
  openDraft(revisionId: RevisionId): Promise<OpenedDraft>;
  /**
   * Save a draft of the session as an ordinary draft save, on `basedOn`,
   * under `revisionId`, renaming no link; one whose answer was lost is sent
   * again unchanged, and `duplicate` then means it landed.
   */
  saveDraft(input: {
    basedOn: RevisionId;
    revisionId: RevisionId;
    payload: PagePayload;
    linkChoices: ReadonlyMap<string, PageId>;
  }): Promise<{ revisionId: RevisionId; payload: PagePayload }>;
  /**
   * The Markdown a save on `basedOn` would write once its links name their
   * pages' current titles, or null if none would change (`renamedLinks`).
   */
  renamed?(payload: PagePayload, basedOn: RevisionId): Promise<string | null>;
  /** What this app knows of access to the page now (`liveAccess`), read again with `refresh`. */
  access(refresh: boolean): Promise<LiveAccess>;
  /** Whether the page is visible, which decides who saves. */
  visible(): boolean;
  /** Which editor shows the page. */
  editor(): 'source' | 'visual';
};

/** Why an app isn't in a session. */
export type NotJoined =
  /** The server has no live sessions. */
  | { kind: 'older-server' }
  /** The page's draft moved on since the editor opened it. */
  | { kind: 'stale-head' }
  /** A session, snapshot or `wikistow.live` of a newer format. */
  | { kind: 'update-app' }
  /** It refused the session, or can't take part: it edits as a writer outside it. */
  | { kind: 'refused'; why: string }
  /** The person typed before the session was joined, and it holds other text. */
  | { kind: 'typed-meanwhile' };

/** Where a participant is. */
export type ParticipantState =
  | { kind: 'live' }
  /** The session ended (`access`: the page's access changed; `ended`: someone ended it). */
  | { kind: 'ended'; reason: 'access' | 'ended' | 'deleted' }
  /** It left, or can't go on: the editor goes on outside the session. */
  | {
      kind: 'stopped';
      why: string;
      /** A session draft that differed from what this app showed, which it saves its own document over. */
      saveOver: RevisionId | null;
      /** Whether it can join again: after an access change, once access allows. */
      rejoin: boolean;
    }
  | { kind: 'left' };

/** Someone else with the draft open, as the toolbar shows them. */
export type LivePerson = {
  id: IdentityId;
  /** Their joins' editors and cursors, one per tab or window. */
  joins: { joinId: JoinId; editor: 'source' | 'visual' | null; cursor: LivePresence['cursor'] }[];
};

/** What a participant shows. A new object whenever any of it changes. */
export type ParticipantStatus = {
  state: ParticipantState;
  /** Whether this app's own typing is in a session draft it has compared, the draft head. */
  saved: boolean;
  /** The draft head as the stream last said. */
  head: RevisionId | null;
  /** The latest session draft this app has compared, which holds what it shows as saved. */
  checked: RevisionId;
  /** Who saves: this app, another person's, or nobody. */
  saver: 'me' | IdentityId | null;
  /** A person whose saves fail, when another app saves instead. */
  failing: { id: IdentityId; reason: string } | null;
  /** Why the shared document can't be saved by anyone, if it can't. */
  tooLarge: string | null;
  /** Others with the draft open, once a message from them verified. */
  people: readonly LivePerson[];
  /** Built from a later snapshot, until a session draft compared equal. */
  provisional: boolean;
  /** Drafts from outside the session whose overlapping parts wait for review (ADR 0015 decision 8). */
  notes: readonly LiveNote[];
  /** Whether the session's stream is open: while it isn't, typing waits unsent, for up to the join's 30 s. */
  connected: boolean;
};

/**
 * A note (ADR 0015 decision 8): a draft written outside the session was
 * folded in, and these of its parts overlapped the session's own changes,
 * which stayed. `by` signed that draft, once this app has opened it.
 * `carried` from an earlier session, by the starting draft.
 */
export type LiveNote = {
  revision: RevisionId;
  parts: readonly string[];
  by: IdentityId | null;
  carried: boolean;
};

/** A note opened for Review: the fold's base, theirs, and the document now. */
export type OpenedNote = {
  revision: RevisionId;
  base: PagePayload;
  theirs: PagePayload;
  ours: PagePayload;
  parts: readonly string[];
  by: IdentityId;
  /** Theirs is a gone join's session draft, which its fold cut so that adds overlap. */
  gone: boolean;
};

/**
 * What putting one join's own typing back takes (section 5.10, **Putting
 * typing back**): the document's payload, `ours`, and the bases a merge by
 * block from it takes, each holding everything the join took in from
 * others and only some of its own changes; null where the document can't
 * be read as a payload.
 */
export type PutBack = {
  sessionId: string;
  joinId: JoinId;
  clientId: number;
  ours: PagePayload | null;
  /** Onto a draft, as a writer outside the session: its own changes the latest session draft it compared holds. */
  outside: PagePayload | null;
  /** The join's own clock in `outside`, and in `ours`. */
  outsideClock: number;
  oursClock: number;
  /** Into the session again, as a newcomer whose document has `state`: its own changes that document placed. */
  inSession(state: LiveState): PagePayload | null;
  /** Whether `state` holds everything of the join's own, typed or deleted. */
  heldBy(state: LiveState): boolean;
};

/** The origin of this app's own changes to the document. */
export const LOCAL_ORIGIN = Symbol('live-local');
/** The origin of changes taken in from others. */
export const REMOTE_ORIGIN = Symbol('live-remote');
/** The origin of a change this app made in a copy and saved itself, as for a file it uploaded. */
export const COPY_ORIGIN = Symbol('live-copy');

const SEND_MS = 100;
const PRESENCE_MS = 15_000;
const DEBOUNCE_MS = 1_000;
const MAX_WAIT_MS = 10_000;
const TAKE_OVER_MS = 20_000;
const CHECK_MS = 10_000;
const HOLD_MS = 30_000;
const GRACE_MS = 25_000;
const SNAPSHOT_BYTES = 256 * 1024;
// A base's own client: one no join derives (53 bits, all set), and which never writes.
const BASE_CLIENT = 0x1fffffffffffff;

const key = (join: JoinRef) => `${join.senderId} ${join.joinId}`;

type SessionDraft = {
  /** Saved by this app, which may then send a Saved notice naming it. */
  ours?: boolean;
  revisionId: RevisionId;
  payload: PagePayload;
  state: LiveState;
  compared: boolean;
  with: readonly IdentityId[];
  openedAt: number;
  /** A draft from outside folded in without a save, by this join's grant (`senderId joinId`). */
  foldedBy?: string;
  /** The draft as opened, for one that turns out to be from outside (its sender's join gone). */
  opened?: OpenedDraft;
};

type Held = {
  stored: liveRoutes.StoredMessage;
  opened: OpenedLiveMessage;
  decoded: DecodedUpdate | undefined;
  since: number;
  reason: 'gap' | 'origin';
};

type Outgoing = { message: LiveMessage; covers?: number };

/**
 * Join the page's live session, the editor having opened the draft
 * `opening` (ADR 0015 decision 1): the open session as a newcomer, or a
 * new one started from that draft. `typed` says whether the person edited
 * before this resolved, which can go into a session only if it holds that
 * draft's text.
 */
export async function joinLive(
  ports: ParticipantPorts,
  opening: { revisionId: RevisionId; payload: PagePayload; region: Region },
): Promise<LiveParticipant | NotJoined> {
  const { ctx, page } = ports;
  if (ctx.agent || isAgentId(ctx.identity.public.id)) return { kind: 'refused', why: 'agent' };
  for (let tries = 0; ; tries++) {
    let served: Awaited<ReturnType<typeof fetchPageSession>>;
    try {
      served = await fetchPageSession(ctx, page.pageId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not-found') return { kind: 'older-server' };
      throw error;
    }
    if (served.open) return newcomer(ports, served.open, served.draftHead);
    if (served.draftHead !== opening.revisionId) return { kind: 'stale-head' };
    try {
      const started = await startPageSession(ctx, { page, ...opening });
      return new LiveParticipant(ports, {
        opened: started.opened,
        joinId: started.joinId,
        document: started.document,
        joins: starterJoins(ctx, started.opened, started.joinId, started.first),
        first: started.first,
        firstPosition: started.position,
        base: { revisionId: opening.revisionId, payload: opening.payload },
        position: started.position,
        covers: started.position,
        kept: undefined,
        head: opening.revisionId,
        provisional: false,
        backlog: [],
      });
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'unsupported-format') {
        return { kind: 'update-app' };
      }
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'stale-head') return { kind: 'stale-head' };
      // Someone started one meanwhile: join theirs.
      if (error.code === 'duplicate' && tries < 2) continue;
      throw error;
    }
  }
}

function starterJoins(
  ctx: ClientContext,
  opened: OpenedLiveSession,
  joinId: JoinId,
  first: LiveMessage,
): LiveJoins {
  const joins = new LiveJoins({
    installationId: ctx.installationId,
    sessionId: opened.record.subjectId,
    starter: { senderId: opened.starter.senderId, joinId: opened.starter.joinId },
  });
  joins.list([
    {
      senderId: ctx.identity.public.id,
      senderKeyVersion: ctx.identity.public.keyVersion,
      joinId,
      parent: null,
      present: true,
    },
  ]);
  // Its first snapshot is its join's first message, which signs the page's text as typed.
  const message = openLiveMessage({
    binding: liveBinding(opened),
    trust: ctx.trust,
    listed: (header) => joins.listed(header),
    message: first,
  });
  const read = readSnapshot(message.content);
  if (read.kind !== 'current') throw new CryptoError('malformed', 'The first snapshot isn’t ours');
  const verdict = joins.check(message, decodeUpdate(read.state));
  if (verdict.kind !== 'take')
    throw new CryptoError('malformed', 'The first snapshot doesn’t check');
  joins.take(message);
  return joins;
}

const listedOf = (joins: readonly liveRoutes.Join[]): ListedJoin[] =>
  joins.map((join) => ({
    senderId: join.senderId,
    senderKeyVersion: join.senderKeyVersion,
    joinId: join.joinId,
    // A further join's parent is always the same person's.
    parent: join.parent ? { senderId: join.senderId, joinId: join.parent } : null,
    present: join.present,
  }));

async function newcomer(
  ports: ParticipantPorts,
  served: liveRoutes.ServedSession,
  head: RevisionId | null,
): Promise<LiveParticipant | NotJoined> {
  let opened: OpenedLiveSession | null = null;
  const joined = await newcomerFrom(ports, served, head, (session) => (opened = session));
  // A session this app didn't join leaves no key behind.
  if (!(joined instanceof LiveParticipant)) (opened as OpenedLiveSession | null)?.key.fill(0);
  return joined;
}

async function newcomerFrom(
  ports: ParticipantPorts,
  served: liveRoutes.ServedSession,
  head: RevisionId | null,
  keep: (opened: OpenedLiveSession) => void,
): Promise<LiveParticipant | NotJoined> {
  const { ctx, page } = ports;
  const access = await ports.access(false);
  let opened: OpenedLiveSession;
  try {
    opened = openServedSession(ctx, served, page, access);
    keep(opened);
  } catch (error) {
    if (error instanceof CryptoError) {
      return error.code === 'unsupported-format'
        ? { kind: 'update-app' }
        : { kind: 'refused', why: error.message };
    }
    throw error;
  }
  try {
    const binding = liveBinding(opened);
    const joins = new LiveJoins({
      installationId: ctx.installationId,
      sessionId: opened.record.subjectId,
      starter: { senderId: opened.starter.senderId, joinId: opened.starter.joinId },
    });
    joins.list(listedOf(served.joins));
    const open = (message: LiveMessage) =>
      openLiveMessage({ binding, trust: ctx.trust, listed: (h) => joins.listed(h), message });
    const joinId = newId(JoinId);
    const clientId = liveClientId({
      installationId: ctx.installationId,
      sessionId: opened.record.subjectId,
      senderId: ctx.identity.public.id,
      senderKeyVersion: ctx.identity.public.keyVersion,
      joinId,
    });
    const first = open(served.firstSnapshot.message);
    const later = served.snapshot ? open(served.snapshot.message) : null;
    const backlog: liveRoutes.StoredMessage[] = [];
    let document: LiveDocument;
    let provisional = false;
    if (later && served.snapshot) {
      // Each join's order starts from its latest kept message at or before
      // what the snapshot covers, the first snapshot counting for its sender's.
      const started = new Set<string>();
      for (const stored of served.latest) {
        const message = open(stored.message);
        joins.startFrom(message);
        started.add(key(message));
      }
      if (!started.has(key(first))) joins.startFrom(first);
      const read = readSnapshot(later.content);
      if (read.kind === 'newer-format') return { kind: 'update-app' };
      const draft = await ports.openDraft(read.revisionId);
      // A draft of the session: signed by a person with a join it has
      // taken a message from, under the record's key material.
      if (!signedInSession(draft, opened, started) || !sameKeys(draft, opened)) {
        throw new CryptoError(
          'binding-mismatch',
          'The snapshot names a draft from outside the session',
        );
      }
      const built = openSnapshot({
        message: later,
        session: opened,
        joins,
        revision: { ...draft, pageId: page.pageId },
        clientId,
      });
      document = built.document;
      provisional = built.provisional;
      // Its poster's further join counts it, when that join's order has started.
      const verdict = joins.check(later, decodeUpdate(read.state));
      if (verdict.kind === 'take') joins.take(later);
      for (const stored of served.messages) backlog.push(stored);
      return joinedOrRefused(
        new LiveParticipant(ports, {
          opened,
          joinId,
          document,
          joins,
          first: served.firstSnapshot.message,
          firstPosition: served.firstSnapshot.position,
          base: null,
          laterDraft: draft,
          position: served.position,
          covers: served.snapshot.covers ?? served.firstSnapshot.position,
          kept: served.complete ? undefined : (served.snapshot.covers ?? undefined),
          head,
          provisional,
          backlog,
          verified: [...started],
          grants: served.grants,
          listed: served.joins,
        }),
      );
    }
    const draft = await ports.openDraft(opened.payload.revisionId);
    const built = openSnapshot({
      message: first,
      session: opened,
      joins,
      revision: { ...draft, pageId: page.pageId },
      clientId,
    });
    document = built.document;
    const read = readSnapshot(first.content);
    if (read.kind === 'newer-format') return { kind: 'update-app' };
    const verdict = joins.check(first, decodeUpdate(read.state));
    if (verdict.kind !== 'take') {
      throw new CryptoError(
        'binding-mismatch',
        'The first snapshot isn’t its join’s first message',
      );
    }
    joins.take(first);
    for (const stored of served.messages) backlog.push(stored);
    return joinedOrRefused(
      new LiveParticipant(ports, {
        opened,
        joinId,
        document,
        joins,
        first: served.firstSnapshot.message,
        firstPosition: served.firstSnapshot.position,
        base: { revisionId: draft.revisionId, payload: draft.payload },
        position: served.position,
        covers: served.firstSnapshot.position,
        kept: served.complete ? undefined : (served.firstSnapshot.position ?? undefined),
        head,
        provisional: false,
        backlog,
        verified: [key(first)],
        grants: served.grants,
        listed: served.joins,
      }),
    );
  } catch (error) {
    opened.key.fill(0);
    if (error instanceof CryptoError) {
      if (error.code === 'unsupported-format') return { kind: 'update-app' };
      // It can't take part: it refused the session's snapshot or a kept
      // message. It ends the session, so the next start makes a fresh one
      // and one bad message can't keep live editing off the page.
      void liveTransport(ctx, opened.record.subjectId, ports.live)
        .end()
        .catch(() => {});
      return { kind: 'refused', why: error.message };
    }
    throw error;
  }
}

// A newcomer that refused a message served with the session stopped, and
// ended it, before it took part: it didn't join.
function joinedOrRefused(participant: LiveParticipant): LiveParticipant | NotJoined {
  const { state } = participant.status();
  if (state.kind === 'live') return participant;
  participant.close();
  return { kind: 'refused', why: state.kind === 'stopped' ? state.why : 'the session ended' };
}

// A draft signed by a person with a join in the session this app has taken a message from.
function signedInSession(
  draft: OpenedDraft,
  opened: OpenedLiveSession,
  taken: ReadonlySet<string>,
): boolean {
  if (isAgentId(draft.authorId)) return false;
  return (
    [...taken].some((join) => join.startsWith(`${draft.authorId} `)) ||
    draft.authorId === opened.starter.senderId
  );
}

// A draft under the session record's key material: its region, and in a share its key version.
const sameKeys = (draft: OpenedDraft, opened: OpenedLiveSession) =>
  sameRegion(draft.region, opened.region) &&
  (opened.region.kind === 'owner' || draft.keyVersion === opened.keyVersion);

type Opening = {
  opened: OpenedLiveSession;
  joinId: JoinId;
  document: LiveDocument;
  joins: LiveJoins;
  first: LiveMessage;
  firstPosition: number;
  /** The draft the session started from, when this app opened it as such. */
  base: { revisionId: RevisionId; payload: PagePayload } | null;
  /** The draft a later snapshot named, for a newcomer built from one. */
  laterDraft?: OpenedDraft;
  position: number;
  /** The position up to which the document holds every stored message, as it starts. */
  covers: number;
  kept: number | undefined;
  head: RevisionId | null;
  provisional: boolean;
  /** Stored messages served with the session, after its snapshot. */
  backlog: liveRoutes.StoredMessage[];
  /** Joins whose kept messages a newcomer started from, which verified. */
  verified?: readonly string[];
  /** The fold grants served with the session (section 5.10, **Saving**). */
  grants?: readonly liveRoutes.Grant[];
  /** The joins served with the session, so its backlog is read knowing which are further joins. */
  listed?: readonly liveRoutes.Join[];
};

/** One app's part in a session. Made by `joinLive`; `start` opens its stream. */
export class LiveParticipant {
  readonly document: LiveDocument;
  readonly sessionId: OpenedLiveSession['record']['subjectId'];
  readonly #ports: ParticipantPorts;
  readonly #opened: OpenedLiveSession;
  readonly #binding: LiveBinding;
  readonly #joins: LiveJoins;
  readonly #transport: LiveTransport;
  readonly #me: JoinRef;
  readonly #clientId: number;
  readonly #abort = new AbortController();
  readonly #listeners = new Set<() => void>();
  readonly #changes = new Set<(local: boolean) => void>();
  #status: ParticipantStatus;

  // The server's list: each join's order and whether it's present, and
  // which joins have sent a message that verified and decrypted.
  readonly #order = new Map<string, number>();
  readonly #present = new Map<string, boolean>();
  readonly #further = new Set<string>();
  readonly #verified = new Set<string>();
  readonly #presence = new Map<string, ReadPresence>();
  readonly #typed = new Set<IdentityId>();

  // Stored messages: the last position seen, those held, and the highest
  // position up to which every stored message has been taken.
  #position: number;
  #kept: number | undefined;
  #held: Held[] = [];
  #covers: number;
  #holdTimer: ReturnType<typeof setTimeout> | null = null;

  // What this app sends: its own updates not yet sealed, sealed messages
  // not yet sent, the one request in flight, and its join's order.
  #pending: Uint8Array[] = [];
  #queue: Outgoing[] = [];
  #sending: Promise<void> | null = null;
  #sendTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSentAt = 0;
  #seq = 1;
  #clock = 0;
  #ownDeletes = new Map<number, { clock: number; length: number }[]>();
  #presenceAt = 0;
  #presenceDirty = true;
  #presenceTimer: ReturnType<typeof setInterval> | null = null;
  #saveFailing: string | null = null;
  #stopSending = false;
  // This join's clock as it joined: the starter's counts the page's text.
  readonly #startClock: number;
  // Taking in the messages served with the session, as it joins.
  #joining = false;
  // Whether its stream has been opened: one never started never saved for anyone.
  #started = false;
  // A change of this app's own copy is on its way: the main join waits for it.
  #placing = false;
  // Whether the server has made this app's join: the starter's with the
  // session, a newcomer's once its stream opened.
  #joined: boolean;

  // Drafts: the head as the stream says, the session's drafts this app
  // has opened, and those it found outside the session.
  #head: RevisionId | null;
  readonly #drafts = new Map<RevisionId, SessionDraft>();
  readonly #outsiders = new Set<RevisionId>();
  #checked: RevisionId;
  #lastCheckAt = 0;
  #checkTimer: ReturnType<typeof setTimeout> | null = null;
  #opening: Promise<void> | null = null;
  #provisional: boolean;

  // Folding drafts from outside (ADR 0015 decision 8): the fold grants as
  // the server tells of them, by subject; revisions whose fold was placed;
  // each draft's signed `basedOn`; the drafts from outside it opened; the
  // latest session draft it saw as head, and the drafts it descends from,
  // which are rollbacks if served as head again.
  readonly #grants = new Map<string, liveRoutes.Grant>();
  // Where each revision's fold was first placed, and when this app heard.
  readonly #placedAt = new Map<string, { position: number; at: number }>();
  readonly #folded = new Set<RevisionId>();
  readonly #basedOn = new Map<RevisionId, RevisionId | null>();
  readonly #outsiderDrafts = new Map<RevisionId, OpenedDraft>();
  #lastHead: SessionDraft | null = null;
  readonly #ancestors = new Set<RevisionId>();
  #folding: Promise<void> | null = null;
  #outsiderSince: { head: RevisionId; at: number } | null = null;
  #foldTimer: ReturnType<typeof setTimeout> | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #foldAsk: { revision: RevisionId; answer: (grant: liveRoutes.Grant | null) => void } | null =
    null;
  // Each further join's parent, and the updates further joins sent, by position.
  readonly #parents = new Map<string, string>();
  readonly #furtherUpdates = new Map<number, { join: string; decoded: DecodedUpdate }>();
  // A fold placed without a save whose Saved notice came before its grant did.
  // By revision and join, so one join's notice never puts another's out.
  readonly #foldNotices = new Map<
    string,
    { revision: RevisionId; join: string; state: LiveState }
  >();
  // Notes waiting for review, as this app counts them (section 5.10, **The
  // document**), and those deleted, which never come back.
  readonly #notes = new Map<RevisionId, LiveNote>();
  readonly #notesGone = new Set<RevisionId>();
  // What the document's `overlaps` held as it was built, for notes carried by its snapshot's draft.
  readonly #snapshotNotes: Map<string, string>;
  readonly #snapshotDraft: RevisionId;

  // Saving: when the document last changed, the first change not yet
  // saved, and the save in flight.
  #changedAt = 0;
  #unsavedSince: number | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<boolean> | null = null;
  #retryAt = 0;
  #bytesSinceSnapshot = 0;
  #snapshotBytes: number;
  #tooLarge: string | null = null;

  // The acknowledged copy (ADR 0015 decision 6), kept as what makes it, so
  // a base holding any part of this join's own changes can be built: the
  // document as this join started, everything it took in from others and
  // its own copies' changes once placed, merged now and then, and each of
  // its own updates as sealed, by `seq`.
  readonly #startUpdate: Uint8Array;
  #othersLog: Uint8Array[] = [];
  readonly #ownLog: { seq: number; update: Uint8Array }[] = [];
  // Whether the stream is open now, and since when it hasn't been.
  #connected = false;

  constructor(ports: ParticipantPorts, opening: Opening) {
    this.#ports = ports;
    this.#opened = opening.opened;
    this.#binding = liveBinding(opening.opened);
    this.#joins = opening.joins;
    this.document = opening.document;
    this.#startUpdate = Y.encodeStateAsUpdate(opening.document.doc);
    this.#clientId = opening.document.clientId;
    this.sessionId = opening.opened.record.subjectId;
    this.#transport = liveTransport(ports.ctx, this.sessionId, ports.live);
    this.#me = { senderId: ports.ctx.identity.public.id, joinId: opening.joinId };
    this.#joined = key(this.#me) === key(opening.opened.starter);
    this.#verified.add(key(this.#me));
    for (const join of opening.verified ?? []) this.#verified.add(join);
    this.#present.set(key(this.#me), true);
    this.#startClock = Y.getState(opening.document.doc.store, opening.document.clientId);
    this.#position = opening.position;
    this.#covers = opening.covers;
    this.#kept = opening.kept;
    this.#head = opening.head;
    this.#provisional = opening.provisional;
    this.#snapshotBytes = opening.first.sealed.ciphertext.length;
    // The starter's join has sent the first snapshot, `seq` 1.
    if (key(this.#me) === key(opening.opened.starter)) {
      this.#seq = 2;
      this.#clock = Y.getState(this.document.doc.store, this.#clientId);
      this.#clocks.set(1, this.#clock);
      this.#sentSeq = 1;
    }
    const firstState = stateOfSnapshot(opening.first, this.#binding, ports.ctx, opening.joins);
    const base = opening.base;
    const record = opening.opened.payload.revisionId;
    if (base && firstState) {
      this.#drafts.set(record, {
        revisionId: record,
        payload: base.payload,
        state: firstState,
        compared: true,
        with: withOf(base.payload),
        openedAt: Date.now(),
      });
    }
    const later = opening.laterDraft;
    if (later) {
      const state = sessionState(later.payload, later.revisionId, this.sessionId);
      if (state) {
        this.#drafts.set(later.revisionId, {
          revisionId: later.revisionId,
          payload: later.payload,
          state,
          // Provisional: compared only once its text checks against what everyone typed.
          compared: false,
          with: withOf(later.payload),
          openedAt: Date.now(),
        });
      }
    }
    this.#checked = base ? record : (later?.revisionId ?? record);
    this.#lastHead = this.#drafts.get(this.#checked) ?? null;
    for (const join of opening.listed ?? []) this.#recordJoin(join);
    for (const grant of opening.grants ?? []) this.#grant(grant);
    this.#snapshotNotes = new Map(this.document.map('overlaps').entries());
    this.#snapshotDraft = later?.revisionId ?? record;
    this.document.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN) this.#own(update);
      // What Yjs placed of someone else's change, or of a copy's once saved: the acknowledged copy's.
      else if (origin === REMOTE_ORIGIN || origin === COPY_ORIGIN) this.#tookIn(update);
    });
    // Yjs doesn't catch what its listeners throw: nothing here may throw past it.
    this.document.doc.on('afterTransaction', (transaction: Y.Transaction) => {
      const { origin } = transaction;
      if (origin !== LOCAL_ORIGIN && origin !== REMOTE_ORIGIN && origin !== COPY_ORIGIN) return;
      if (transaction.changed.size === 0 && transaction.deleteSet.clients.size === 0) return;
      const local = transaction.origin === LOCAL_ORIGIN;
      try {
        this.#changed();
      } catch {
        // Reported by the change's own checks.
      }
      for (const listener of this.#changes) {
        try {
          listener(local);
        } catch {
          // A listener's own failure stays its own.
        }
      }
    });
    this.#status = this.#computeStatus({ kind: 'live' });
    if (this.#stopLater) {
      const { why, saveOver, rejoin, end } = this.#stopLater;
      this.#stop(why, saveOver, rejoin, end || true);
    }
    this.document.map('overlaps').observe((event) => {
      for (const changed of event.keysChanged) {
        try {
          this.#noteChanged(changed);
        } catch {
          // A note that doesn't read counts as none.
        }
      }
    });
    // A kept message refused as it joins means it can't take part: that ends the session.
    this.#joining = true;
    for (const stored of opening.backlog) this.#receive(stored);
    this.#joining = false;
  }

  /** Open the stream: take part from here on. */
  start(): void {
    if (this.#status.state.kind !== 'live') return;
    this.#started = true;
    void this.#run();
    this.#presenceTimer = setInterval(() => {
      this.#presenceDirty = true;
      this.#schedule();
    }, PRESENCE_MS);
    this.#schedule();
    void this.#learnHead();
    void this.#countCarried();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  status = (): ParticipantStatus => this.#status;

  /**
   * Hear just before someone else's change goes into the document, so an
   * edit an editor hasn't reported yet goes in first, as the change of the
   * text it was made on.
   */
  onBeforeRemote(listener: () => void): () => void {
    this.#beforeRemote.add(listener);
    return () => void this.#beforeRemote.delete(listener);
  }

  readonly #beforeRemote = new Set<() => void>();

  /** Hear every change to the document, `local` for this app's own. */
  onChange(listener: (local: boolean) => void): () => void {
    this.#changes.add(listener);
    return () => void this.#changes.delete(listener);
  }

  /** Make a change of the person's own, sent within a tenth of a second. */
  edit(change: (document: LiveDocument) => void): void {
    if (this.#status.state.kind !== 'live') return;
    const misplaced = this.document.edit(() => change(this.document), LOCAL_ORIGIN);
    if (misplaced.length > 0) this.#stop(`this app wrote ${misplaced[0]?.why}`, null, false);
  }

  /**
   * The person's edit of the document's text parts and maps, as their own
   * change in one transaction: each text by its smallest change, each map
   * entry set to its JSON text or, as null, deleted.
   */
  change(spec: DocumentChange, { byLines = false }: { byLines?: boolean } = {}): void {
    this.edit((document) => applyChange(document, spec, byLines));
  }

  /** The origin of the person's own changes, as an editor binding tells them apart. */
  readonly localOrigin: unknown = LOCAL_ORIGIN;

  /** The person's caret and selection in `body`, as Yjs relative positions, or none. */
  setCursor(cursor: { anchor: Uint8Array; head: Uint8Array } | null): void {
    const same =
      cursor === this.#cursor ||
      (cursor !== null &&
        this.#cursor !== null &&
        equalBytes(cursor.anchor, this.#cursor.anchor) &&
        equalBytes(cursor.head, this.#cursor.head));
    if (same) return;
    this.#cursor = cursor;
    this.presenceChanged();
  }

  #cursor: { anchor: Uint8Array; head: Uint8Array } | null = null;

  /** The person's presence changed: visible, editor or cursor. */
  presenceChanged(): void {
    this.#presenceDirty = true;
    this.#schedule();
  }

  /** The draft this app would base a save outside the session on: the latest it compared. */
  get checkedDraft(): { revisionId: RevisionId; payload: PagePayload } | null {
    const draft = this.#drafts.get(this.#checked);
    return draft ? { revisionId: draft.revisionId, payload: draft.payload } : null;
  }

  /** Every draft of the session this app has opened or saved: drafts of its own, not someone else's saves. */
  sessionDrafts(): RevisionId[] {
    return [...this.#drafts.keys()];
  }

  /** The payload a save would write from the document now, with the head's link table. */
  currentPayload(): PagePayload {
    return this.#payload();
  }

  /** The head draft's payload, for the link table and attachment order a save writes. */
  get headPayload(): PagePayload | null {
    return (
      (this.#head && this.#drafts.get(this.#head)?.payload) ?? this.checkedDraft?.payload ?? null
    );
  }

  /**
   * Check that access to the page still allows the session (section 5.10,
   * **Opening the record**), as on every change of marks, keys or owners;
   * stop sending at once and leave if it doesn't.
   */
  async recheck(): Promise<void> {
    if (this.#status.state.kind !== 'live') return;
    // At once, from the marks as read already: a change pending or a mark raised stops sending.
    if (!this.#accessHolds()) return;
    let access: LiveAccess;
    try {
      access = await this.#ports.access(true);
      this.#recheckFailures = 0;
    } catch {
      // What the marks say held just now. Access that can't be read again,
      // try after try, can't be checked: then it stops, and joins again later.
      if (++this.#recheckFailures >= 3) {
        this.#stopSending = true;
        return this.#stop('access to the page couldn’t be checked', null, true);
      }
      setTimeout(() => void this.recheck(), 5_000);
      return;
    }
    try {
      requireLiveAccess(this.#opened, access);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      this.#stopSending = true;
      this.#stop(error.message, null, true);
    }
  }

  #recheckFailures = 0;
  #stopLater: { why: string; saveOver: RevisionId | null; rejoin: boolean; end: boolean } | null =
    null;

  /**
   * The checks of `requireLiveAccess` this app can make at once, from the
   * marks it holds (section 6.8): in a share, no change of the share
   * pending and no No going back mark above the session's key version.
   * Leaves when they fail.
   */
  #accessHolds(): boolean {
    const { region } = this.#opened;
    if (region.kind !== 'share') return true;
    const { marks } = this.#ports.ctx;
    try {
      if (changePending(marks, region.spaceId, region.shareId)) {
        throw new CryptoError('key-version', 'A change of the share is waiting for its answer');
      }
      requireNotBehind({
        marks,
        spaceId: region.spaceId,
        shareId: region.shareId,
        keyVersion: this.#opened.keyVersion ?? 0,
      });
      return true;
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      this.#stopSending = true;
      this.#stop(error.message, null, true);
      return false;
    }
  }

  /** The page's draft region as this app knows it now: one other than the session's ends it here. */
  regionIs(region: Region): void {
    if (this.#status.state.kind === 'live' && !sameRegion(region, this.#opened.region)) {
      this.#stopSending = true;
      this.#stop('the page moved to another region', null, true);
    }
  }

  /**
   * Save the shared document now, as any app may to publish or to leave
   * (ADR 0015 decision 5), once everything typed here is sent: true once
   * the head is a session draft holding this app's typing that it compared.
   */
  async saveNow(): Promise<boolean> {
    await this.flush();
    if (this.#status.saved) return true;
    // Built from a snapshot nobody has checked yet: its whole document is
    // never saved on leaving, locking or publishing (section 5.10).
    if (this.#provisional) return false;
    // Someone may save first: then the new head is opened at once, and
    // counts as done when it holds this app's typing and compares equal;
    // otherwise this app saves on top of it again (section 5.10, **Saving**).
    for (let tries = 0; tries < 3 && this.#keyed(); tries++) {
      await this.#save({ force: true });
      await this.#ensureHead();
      this.#compare();
      this.#update();
      if (this.#status.saved) return true;
    }
    return this.#status.saved;
  }

  /**
   * Restore a version through the session (section 5.10, **Restoring**):
   * its text put in as this person's change, replacing the page's, in a
   * copy under a further join, since its files are sealed again for the
   * draft and only the restorer can commit them; saved by `write` on the
   * head with `restoredFrom` and `wikistow.live`, as a draft of the
   * session; and sent once that lands. `write` hands the restored payload,
   * its files sealed again, to `shape`, and saves what that returns.
   * Whether it went in; nothing went to anyone when it didn't.
   */
  restoreThrough(
    write: (input: {
      basedOn: RevisionId;
      revisionId: RevisionId;
      shape: (restored: PagePayload) => PagePayload;
    }) => Promise<{ revisionId: RevisionId; payload: PagePayload }>,
  ): Promise<boolean> {
    return this.#tracked(this.#restoreThrough(write));
  }

  async #restoreThrough(
    write: (input: {
      basedOn: RevisionId;
      revisionId: RevisionId;
      shape: (restored: PagePayload) => PagePayload;
    }) => Promise<{ revisionId: RevisionId; payload: PagePayload }>,
  ): Promise<boolean> {
    // On the head, a session draft this app holds, with nothing of its own unsent:
    // given a few seconds, as the head the stream names may still be on its way.
    let headId: RevisionId | null = null;
    let head: SessionDraft | undefined;
    for (let tries = 0; tries < 10; tries++) {
      if (!this.#keyed()) return false;
      await this.flush();
      await this.#ensureHead();
      headId = this.#head;
      head = headId ? this.#drafts.get(headId) : undefined;
      const ready =
        this.#pending.length === 0 &&
        this.#queue.length === 0 &&
        !this.#placing &&
        head !== undefined &&
        holdsState(this.document.state(), head.state);
      if (ready) break;
      head = undefined;
      await sleep(300, this.#abort.signal);
    }
    if (!this.#keyed() || !headId || !head) return false;
    const ctx = this.#ports.ctx;
    const further = newId(JoinId);
    const clientId = liveClientId({
      installationId: ctx.installationId,
      sessionId: this.sessionId,
      senderId: ctx.identity.public.id,
      senderKeyVersion: ctx.identity.public.keyVersion,
      joinId: further,
    });
    const covers = this.#covers;
    const people = [...new Set<IdentityId>([...head.with, ...this.#typed, ctx.identity.public.id])];
    const revisionId = newId(RevisionId);
    const base = Y.encodeStateAsUpdate(this.document.doc);
    // Made afresh each time the write asks, as it may again with fresh keys.
    let made: {
      copy: LiveDocument;
      update: Uint8Array;
      written: PagePayload;
      message: LiveMessage;
    } | null = null;
    const shape = (restored: PagePayload): PagePayload => {
      const copy = new LiveDocument(clientId);
      if (copy.apply(base, 'copy').length > 0) throw new Error('The page couldn’t be copied');
      const updates: Uint8Array[] = [];
      copy.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === LOCAL_ORIGIN) updates.push(update);
      });
      const misplaced = copy.edit(() => writeTarget(copy, targetOf(restored)), LOCAL_ORIGIN);
      if (misplaced.length > 0) throw new Error('The version doesn’t fit the live page');
      const written = this.#payload(restored, copy);
      const update = updates.length > 0 ? Y.mergeUpdates(updates) : new Uint8Array([0, 0]);
      // Sealed before the save, so one too large to send is never saved.
      const message = seal(2, 'update', Y.getState(copy.doc.store, clientId), update);
      made = { copy, update, written, message };
      return withLive(written, {
        revision: revisionId,
        session: this.sessionId,
        state: copy.stateBytes(),
        with: people,
      });
    };
    const seal = (seq: number, kind: 'update' | 'saved', clock: number, content: Uint8Array) =>
      this.#seal({ kind, joinId: further, seq, clock, content });
    const send = (message: LiveMessage, covered?: number) =>
      this.#sendAgain({
        joinId: further,
        parent: this.#me.joinId,
        messages: [{ message, ...(covered !== undefined && { covers: covered }) }],
      });
    let result: { revisionId: RevisionId; payload: PagePayload };
    try {
      await send(seal(1, 'update', 0, new Uint8Array([0, 0])));
      if (!this.#keyed()) return false;
      result = await this.#whileAlive(further, () => write({ basedOn: headId, revisionId, shape }));
    } catch {
      void this.#transport.leave(further).catch(() => {});
      return false;
    }
    const done = made as {
      copy: LiveDocument;
      update: Uint8Array;
      written: PagePayload;
      message: LiveMessage;
    } | null;
    if (!done) {
      void this.#transport.leave(further).catch(() => {});
      return false;
    }
    // It landed: whatever happens next, it is restored, and others fold in what they lack.
    if (!this.#keyed()) {
      void this.#transport.leave(further).catch(() => {});
      return true;
    }
    this.#placing = true;
    try {
      this.document.apply(done.update, COPY_ORIGIN);
      const clock = Y.getState(done.copy.doc.store, clientId);
      await send(done.message);
      this.#drafts.set(result.revisionId, {
        ours: true,
        revisionId: result.revisionId,
        payload: result.payload,
        state: done.copy.state(),
        compared: samePayload(done.written, result.payload),
        with: people,
        openedAt: Date.now(),
      });
      if (this.#head === headId) this.#head = result.revisionId;
      if (this.#drafts.get(result.revisionId)?.compared) this.#checked = result.revisionId;
      this.#seenOwn(result.revisionId, headId);
      if (!this.#keyed()) return true;
      await send(
        seal(3, 'saved', clock, stateContent(result.revisionId, done.copy.stateBytes())),
        covers,
      );
      void this.#transport.leave(further).catch(() => {});
    } catch {
      this.#stop('a restored version couldn’t be sent', null, true);
      return true;
    } finally {
      this.#placing = false;
      this.#schedule();
      this.#update();
    }
    return true;
  }

  /**
   * Make a change this app must save itself before anyone else sees it,
   * as a file it uploaded, which only its uploader may commit to a revision
   * (section 5.10, **Files**): in a copy of the document under a further
   * join of its own, saved as a draft of the session, and sent from that
   * join once the save has landed, with a Saved notice after it. Its main
   * join sends nothing built on it until it is placed. Whether it went in.
   */
  commitOwn(change: ((document: LiveDocument) => void) | DocumentChange): Promise<boolean> {
    return this.#tracked(this.#commitOwn(change));
  }

  // Work whose save may land after it began: leaving waits for it, so its
  // change goes out with it rather than being claimed by a draft nobody gets.
  readonly #work = new Set<Promise<unknown>>();
  #leaving = false;

  #tracked<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work);
    void work.then(
      () => this.#work.delete(work),
      () => this.#work.delete(work),
    );
    return work;
  }

  async #commitOwn(change: ((document: LiveDocument) => void) | DocumentChange): Promise<boolean> {
    // Text given whole is made a change of the text as it is now, anchored
    // in it, so whatever others type meanwhile, around it, stays.
    const make = typeof change === 'function' ? change : this.#anchored(change);
    if (!this.#keyed()) return false;
    await this.flush();
    await this.#ensureHead();
    const headId = this.#head;
    const head = headId ? this.#drafts.get(headId) : undefined;
    if (!this.#keyed() || this.#pending.length > 0 || this.#queue.length > 0) return false;
    // One copy at a time: the main join waits for each to be placed.
    if (this.#placing) return false;
    if (!headId || !head || !holdsState(this.document.state(), head.state)) return false;
    const further = newId(JoinId);
    const ctx = this.#ports.ctx;
    const clientId = liveClientId({
      installationId: ctx.installationId,
      sessionId: this.sessionId,
      senderId: ctx.identity.public.id,
      senderKeyVersion: ctx.identity.public.keyVersion,
      joinId: further,
    });
    const copy = new LiveDocument(clientId);
    if (copy.apply(Y.encodeStateAsUpdate(this.document.doc), 'copy').length > 0) return false;
    // What the copy holds of the stored messages: everything up to here.
    const covers = this.#covers;
    const updates: Uint8Array[] = [];
    copy.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN) updates.push(update);
    });
    if (copy.edit(() => make(copy), LOCAL_ORIGIN).length > 0 || updates.length === 0) {
      return false;
    }
    const update = Y.mergeUpdates(updates);
    const seal = (seq: number, kind: 'update' | 'saved', clock: number, content: Uint8Array) =>
      this.#seal({ kind, joinId: further, seq, clock, content });
    const send = (message: LiveMessage, covers?: number) =>
      this.#sendAgain({
        joinId: further,
        parent: this.#me.joinId,
        messages: [{ message, ...(covers !== undefined && { covers }) }],
      });
    let result: { revisionId: RevisionId; payload: PagePayload };
    const revisionId = newId(RevisionId);
    const stateBytes = copy.stateBytes();
    const savedState = copy.state();
    const people = new Set<IdentityId>([...head.with, ...this.#typed]);
    const payload = this.#payload(head.payload, copy);
    try {
      // The further join, made before the save, belonging to this app's join.
      await send(seal(1, 'update', 0, new Uint8Array([0, 0])));
      if (!this.#keyed()) return false;
      result = await this.#whileAlive(further, () =>
        this.#ports.saveDraft({
          basedOn: headId,
          revisionId,
          payload: withLive(payload, {
            revision: revisionId,
            session: this.sessionId,
            state: stateBytes,
            with: [...people],
          }),
          linkChoices: this.#linkChoices(copy),
        }),
      );
    } catch {
      // Nothing of it went to anyone: a refused save leaves nothing behind.
      void this.#transport.leave(further).catch(() => {});
      return false;
    }
    if (!this.#keyed()) {
      void this.#transport.leave(further).catch(() => {});
      return false;
    }
    // Landed: the change goes into this app's document and out to everyone.
    this.#placing = true;
    try {
      this.document.apply(update, COPY_ORIGIN);
      const clock = Y.getState(copy.doc.store, clientId);
      await send(seal(2, 'update', clock, update));
      this.#drafts.set(result.revisionId, {
        ours: true,
        revisionId: result.revisionId,
        payload: result.payload,
        state: savedState,
        compared: samePayload(payload, result.payload),
        with: [...people],
        openedAt: Date.now(),
      });
      if (this.#head === headId) this.#head = result.revisionId;
      if (this.#drafts.get(result.revisionId)?.compared) this.#checked = result.revisionId;
      this.#seenOwn(result.revisionId, headId);
      if (!this.#keyed()) return true;
      await send(seal(3, 'saved', clock, stateContent(result.revisionId, stateBytes)), covers);
      // Done with: a join has at most two further joins at a time.
      void this.#transport.leave(further).catch(() => {});
    } catch {
      // The draft claims a change the others never got: the session can't go on with it.
      this.#stop('a file’s change couldn’t be sent', null, true);
      return false;
    } finally {
      this.#placing = false;
      this.#schedule();
      this.#update();
    }
    return true;
  }

  // A change of the document as it is now, to be made later in a copy of it:
  // each text's smallest change, its edges held as relative positions.
  #anchored({ texts = {}, entries = [] }: DocumentChange): (document: LiveDocument) => void {
    const spans = (Object.entries(texts) as [TextRoot, string][]).flatMap(([name, target]) => {
      const text = this.document.text(name);
      // Each run of lines that differs, so typing between them stays where it goes.
      return textChanges(text.toJSON(), target.toWellFormed()).map((span) => {
        const from = Y.createRelativePositionFromTypeIndex(text, span.from);
        // An insertion has one place, which typing there meanwhile goes before.
        const to =
          span.remove === 0
            ? from
            : Y.createRelativePositionFromTypeIndex(text, span.from + span.remove, -1);
        return { name, span, from, to };
      });
    });
    return (document) => {
      // Where each was can't be found: those texts whole, as given.
      const whole = new Set<TextRoot>();
      const placed = spans.map(({ name, span, from, to }) => {
        const text = document.text(name);
        const start = Y.createAbsolutePositionFromRelativePosition(from, document.doc);
        const end = Y.createAbsolutePositionFromRelativePosition(to, document.doc);
        if (!start || !end || start.type !== text || end.type !== text || end.index < start.index) {
          whole.add(name);
        }
        return { name, span, start: start?.index ?? 0, end: end?.index ?? 0 };
      });
      // From the end of each text, so each place stays where it was found.
      for (const { name, span, start, end } of placed.toReversed()) {
        if (whole.has(name)) continue;
        const text = document.text(name);
        if (end > start) text.delete(start, end - start);
        if (span.insert !== '') text.insert(start, span.insert);
      }
      for (const name of whole) changeText(document.text(name), texts[name] ?? '');
      applyChange(document, { entries });
    };
  }

  /**
   * Run `work`, a save, keeping the further join `further` present
   * meanwhile with a request from it every 10 s holding no messages, as a
   * save that takes longer than a join's 30 s, re-sealing many files, needs.
   * Each request finishes before the next, and before `work`'s result goes
   * back, so the join still has one request in flight at a time.
   */
  async #whileAlive<T>(further: JoinId, work: () => Promise<T>): Promise<T> {
    let done = false;
    let flying: Promise<unknown> = Promise.resolve();
    const beat = async () => {
      while (!done) {
        await sleep(10_000, this.#abort.signal);
        if (done || !this.#keyed()) return;
        flying = this.#transport
          .send({ joinId: further, parent: this.#me.joinId, messages: [] })
          .catch(() => {});
        await flying;
      }
    };
    const beating = beat();
    try {
      return await work();
    } finally {
      done = true;
      await flying;
      void beating;
    }
  }

  /**
   * Send a request from one of this app's joins, again unchanged after a
   * lost answer or a refusal to hurry, until it is answered.
   */
  async #sendAgain(body: Parameters<LiveTransport['send']>[0]) {
    for (let tries = 0; ; tries++) {
      if (!this.#accessHolds()) throw new CryptoError('key-version', 'Access to the page changed');
      try {
        return await this.#transport.send(body);
      } catch (error) {
        const again =
          error instanceof ApiError && (outcomeUnknown(error) || error.code === 'rate-limited');
        if (!again || tries >= 20 || !this.#keyed()) throw error;
        await sleep(Math.min(250 * 2 ** tries, 2_000), this.#abort.signal);
      }
    }
  }

  // Whether the session key is still this app's to seal with: it is wiped on leaving and locking.
  #keyed(): boolean {
    return this.#status.state.kind === 'live' && !this.#stopSending && !this.#abort.signal.aborted;
  }

  /** Seal a message as this person, never once the session key is wiped or sending stopped. */
  #seal(message: {
    kind: LiveMessage['kind'];
    joinId: JoinId;
    seq: number;
    clock: number;
    content: Uint8Array;
  }): LiveMessage {
    if (!this.#keyed()) throw new CryptoError('malformed', 'This app is no longer in the session');
    return sealLiveMessage({
      sender: this.#ports.ctx.identity,
      binding: this.#binding,
      ...message,
    });
  }

  /**
   * After the session ended or this app stopped (ADR 0015 decision 12):
   * the draft to go on from outside the session, and whether the document
   * still needs saving there. When the document has exactly the head's
   * state, it is compared at once; when it holds the head, a session draft,
   * the head is the base; otherwise the latest draft it compared is, and a
   * save on it meets the conflict, with **Merge…**.
   */
  async settle({ save = false }: { save?: boolean } = {}): Promise<{
    base: { revisionId: RevisionId; payload: PagePayload } | null;
    payload: PagePayload | null;
    saved: boolean;
    /** Whether the person changed anything in the session. */
    mine: boolean;
    /**
     * Built from a later snapshot and never compared equal: the document
     * may hold text nobody typed, so it is never saved over a draft unasked.
     */
    provisional: boolean;
    /** Whether `base` is the draft head, a session draft the document holds. */
    atHead: boolean;
  }> {
    const provisional = this.#provisional;
    const mine =
      Y.getState(this.document.doc.store, this.#clientId) > this.#startClock ||
      this.#ownDeletes.size > 0;
    if (this.#head && !this.#drafts.has(this.#head) && !this.#outsiders.has(this.#head)) {
      await this.#openHead(this.#head);
    }
    let payload: PagePayload | null;
    try {
      payload = this.#payload();
    } catch {
      payload = null;
    }
    if (save && mine && !provisional && payload) await this.#saveOnLeaving(payload);
    const head = this.#head ? this.#drafts.get(this.#head) : undefined;
    let state: LiveState | null = null;
    try {
      state = this.document.state();
    } catch {
      state = null;
    }
    if (head && state && holdsState(state, head.state)) {
      if (!head.compared && sameState(state, head.state) && payload) {
        head.compared = samePayload(this.document.payload(head.payload), head.payload);
      }
      const saved = head.compared && sameState(state, head.state);
      return {
        base: { revisionId: head.revisionId, payload: head.payload },
        payload,
        saved: saved && !provisional,
        mine,
        provisional,
        atHead: true,
      };
    }
    return { base: this.checkedDraft, payload, saved: false, mine, provisional, atHead: false };
  }

  /**
   * At the session's end (section 5.10, **Ending**): save this app's own
   * document on top of the head, unless the head is a session draft it has
   * compared, or one with exactly its document's state that compares equal
   * now. A `stale-head` counts as done when the new head is such a draft;
   * one the document holds is saved on top of again. Anything else is left
   * to the editor, which meets the conflict.
   */
  async #saveOnLeaving(payload: PagePayload): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const headId = this.#head;
      if (!headId) return;
      if (!this.#drafts.has(headId) && !this.#outsiders.has(headId)) await this.#openHead(headId);
      const head = this.#drafts.get(headId);
      if (!head) return;
      let state: LiveState;
      try {
        state = this.document.state();
      } catch {
        return;
      }
      if (!holdsState(state, head.state)) return;
      if (sameState(state, head.state)) {
        if (!head.compared)
          head.compared = samePayload(this.document.payload(head.payload), head.payload);
        if (head.compared) return;
      }
      const revisionId = newId(RevisionId);
      try {
        const result = await this.#ports.saveDraft({
          basedOn: headId,
          revisionId,
          payload: withLive(payload, {
            revision: revisionId,
            session: this.sessionId,
            state: this.document.stateBytes(),
            with: [...new Set<IdentityId>([...head.with, ...this.#typed])],
          }),
          linkChoices: this.#linkChoices(),
        });
        this.#drafts.set(result.revisionId, {
          revisionId: result.revisionId,
          payload: result.payload,
          state,
          compared: samePayload(payload, result.payload),
          with: head.with,
          openedAt: Date.now(),
        });
        this.#head = result.revisionId;
        if (this.#drafts.get(result.revisionId)?.compared) this.#checked = result.revisionId;
        return;
      } catch (error) {
        const detail =
          error instanceof ApiError && error.code === 'stale-head' ? error.detail : null;
        const next = RevisionId.safeParse((detail as { draftHead?: unknown } | null)?.draftHead);
        if (!next.success) return;
        // Another app saved first, its end save maybe: look at what it holds.
        this.#head = next.data;
      }
    }
  }

  /** Send everything typed here that isn't sent yet. */
  async flush(): Promise<void> {
    for (let tries = 0; tries < 50; tries++) {
      if (this.#sending) await this.#sending.catch(() => {});
      if (this.#pending.length === 0 && this.#queue.length === 0) return;
      if (this.#stopSending || this.#status.state.kind !== 'live') return;
      if (!this.#joined || this.#placing) await sleep(SEND_MS, this.#abort.signal);
      else await this.#send();
    }
  }

  /**
   * Leave the session (ADR 0015 decision 5): send what's unsent, save the
   * document unless the head holds this app's typing, then say so to the
   * server and wipe the session key. Whether everything typed here is saved.
   */
  async leave(): Promise<boolean> {
    if (this.#status.state.kind === 'left') return this.#status.saved;
    this.#leaving = true;
    // A fold, restore, file or rename in flight goes out first, with its change.
    await withTimeout(Promise.allSettled([...this.#work]), 10_000).catch(() => {});
    let saved = this.#status.saved;
    if (this.#status.state.kind === 'live' && !this.#stopSending && this.#started) {
      saved = await withTimeout(this.saveNow(), 8_000).catch(() => false);
      // Once the server has placed and relayed what it sent, it says what's saved.
      for (let waited = 0; waited < 1_500 && this.#covers < this.#placed; waited += SEND_MS) {
        await sleep(SEND_MS, this.#abort.signal);
      }
      this.#trail();
      await withTimeout(this.flush(), 2_000).catch(() => {});
    }
    this.#close({ kind: 'left' });
    return saved;
  }

  /**
   * After the session ended or this app stopped: the document as it is,
   * to go on with outside the session, and whether its typing was saved.
   */
  settled(): { payload: PagePayload | null; saved: boolean } {
    try {
      return { payload: this.#payload(), saved: this.#status.saved };
    } catch {
      return { payload: null, saved: this.#status.saved };
    }
  }

  /**
   * What putting this app's own typing back takes (section 5.10, **Putting
   * typing back**), once it left the session or is about to keep its
   * document on the device: the document as it is, and the bases a merge
   * by block takes. Each base holds everything this app took in from
   * others and only some of its own changes, so only what the person typed
   * counts as theirs. It works after the session key is wiped: it seals nothing.
   */
  putBack(): PutBack {
    let ours: PagePayload | null;
    try {
      ours = this.#payload();
    } catch {
      ours = null;
    }
    const checked = this.#drafts.get(this.#checked);
    // Onto a draft, as a writer outside the session: of its own, only what
    // the latest session draft it compared holds, since a head it hasn't
    // compared may lack what the session served.
    const outsideThrough = checked ? this.#ownThrough(checked.state) : 0;
    const own = () => Y.getState(this.document.doc.store, this.#clientId);
    return {
      sessionId: this.sessionId,
      joinId: this.#me.joinId,
      clientId: this.#clientId,
      ours,
      outside: this.#baseOf(outsideThrough),
      outsideClock: this.#ownClockThrough(outsideThrough),
      oursClock: own(),
      // Into the session again, as a newcomer: of its own, exactly what that
      // newcomer's document, built from what the session serves, placed.
      inSession: (state) => this.#baseOf(this.#ownThrough(state)),
      heldBy: (state) => {
        try {
          return holdsState(state, this.#ownState());
        } catch {
          return false;
        }
      },
    };
  }

  // The highest `seq` up to which `state` holds every update this join sent, message by message.
  #ownThrough(state: LiveState): number {
    let through = 0;
    for (const { seq, update } of this.#ownLog) {
      let held: boolean;
      try {
        held = holdsState(state, plusUpdate({ vector: new Map(), deletes: new Map() }, decodeUpdate(update)));
      } catch {
        held = false;
      }
      if (!held) break;
      through = seq;
    }
    return through;
  }

  // This join's own clock once its updates up to `seq` are in.
  #ownClockThrough(seq: number): number {
    let clock = this.#startClock;
    for (const entry of this.#ownLog) {
      if (entry.seq > seq) break;
      try {
        for (const structs of decodeUpdate(entry.update).structs) {
          if (structs.client === this.#clientId) clock = Math.max(clock, structs.end);
        }
      } catch {
        // Counted as none.
      }
    }
    return clock;
  }

  // A base for putting typing back: the document as this join started, all
  // it took in from others, and its own updates up to `seq`.
  #baseOf(seq: number): PagePayload | null {
    try {
      const base = new LiveDocument(BASE_CLIENT);
      base.apply(this.#startUpdate, 'base');
      if (this.#othersLog.length > 0) base.apply(Y.mergeUpdates(this.#othersLog), 'base');
      for (const entry of this.#ownLog) {
        if (entry.seq > seq) break;
        base.apply(entry.update, 'base');
      }
      return this.#payload(this.headPayload, base);
    } catch {
      return null;
    }
  }

  // Someone else's change, or a copy's, as Yjs placed it: into the acknowledged copy's log.
  #tookIn(update: Uint8Array): void {
    this.#othersLog.push(update);
    if (this.#othersLog.length >= 256) {
      try {
        this.#othersLog = [Y.mergeUpdates(this.#othersLog)];
      } catch {
        // Kept as they are: merged when the base is built.
      }
    }
  }

  /** Where this join's own typing has reached: a change put in now is held once a document holds it. */
  ownMark(): { sessionId: string; joinId: JoinId; clientId: number; clock: number } {
    return {
      sessionId: this.sessionId,
      joinId: this.#me.joinId,
      clientId: this.#clientId,
      clock: Y.getState(this.document.doc.store, this.#clientId),
    };
  }

  /** Close without saving, as when the vault locks: the key is wiped. */
  close(): void {
    this.#close({ kind: 'left' });
  }

  #close(state: ParticipantState): void {
    const wasLive = this.#status.state.kind === 'live' || this.#status.state.kind === 'stopped';
    this.#abort.abort();
    for (const timer of [
      this.#sendTimer,
      this.#saveTimer,
      this.#checkTimer,
      this.#holdTimer,
      this.#trailTimer,
      this.#foldTimer,
      this.#noticeTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    if (this.#presenceTimer) clearInterval(this.#presenceTimer);
    this.#foldAsk?.answer(null);
    this.#foldAsk = null;
    if (wasLive && this.#status.state.kind !== 'ended') {
      void this.#transport.leave(this.#me.joinId).catch(() => {});
    }
    this.#binding.key.fill(0);
    if (this.#status.state.kind !== 'left') this.#update(state);
  }

  // ---- Receiving ----

  async #run(): Promise<void> {
    let pause = 500;
    let brokeAt: number | null = null;
    while (!this.#abort.signal.aborted && this.#status.state.kind === 'live') {
      try {
        const kept =
          this.#kept !== undefined && this.#position < this.#kept ? this.#kept : undefined;
        for await (const line of this.#transport.stream(
          { after: this.#position, joinId: this.#me.joinId, ...(kept !== undefined && { kept }) },
          this.#abort.signal,
        )) {
          brokeAt = null;
          pause = 500;
          if (!this.#joined) {
            this.#joined = true;
            this.#schedule();
          }
          if (!this.#connected) {
            // Back: what it typed meanwhile goes out from its join, as it was made.
            this.#connected = true;
            this.#schedule();
            this.#update();
          }
          this.#line(line);
          if (this.#status.state.kind !== 'live') return;
        }
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        if (error instanceof ApiError && !outcomeUnknown(error) && error.code !== 'rate-limited') {
          // The join went, a snapshot deleted what it missed, or the stream was
          // refused: it joins again as a newcomer, putting its typing back.
          return this.#stop(`the session’s stream was refused (${error.code})`, null, true);
        }
      }
      if (this.#abort.signal.aborted || this.#status.state.kind !== 'live') return;
      if (this.#connected) {
        this.#connected = false;
        this.#update();
      }
      brokeAt ??= Date.now();
      if (Date.now() - brokeAt > GRACE_MS) {
        return this.#stop('the connection to the session was lost', null, true);
      }
      await sleep(pause, this.#abort.signal);
      // While the server doesn't answer, it asks again every 2 s, so a short
      // break resumes within the join's 30 s (ADR 0015 decision 10).
      pause = Math.min(pause * 2, 2_000);
    }
  }

  #line(line: liveRoutes.StreamLine): void {
    if ('joins' in line) this.#listJoins(line.joins);
    else if ('message' in line) this.#receive(line.message);
    else if ('presence' in line) this.#receivePresence(line.presence);
    else if ('grant' in line) this.#grant(line.grant);
    else if ('ended' in line) {
      this.#setHead(line.draftHead);
      return this.#ended(line.ended);
    }
    this.#setHead(line.draftHead);
    this.#update();
  }

  #listJoins(joins: readonly liveRoutes.Join[]): void {
    this.#joins.list(listedOf(joins));
    for (const join of joins) this.#recordJoin(join);
    // A join that went may leave the head claiming what it never sent: fold it in.
    queueMicrotask(() => this.#compare());
    for (const held of this.#held) {
      if (held.reason === 'gap' && this.#present.get(key(held.opened)) === false) {
        // A gap from a join that went can't close.
        return this.#stop('a join went with messages missing', null, true);
      }
    }
    this.#scheduleSave();
  }

  // A join as the server lists it: its order, whether it's there, and the join it belongs to.
  #recordJoin(join: liveRoutes.Join): void {
    const ref = key({ senderId: join.senderId, joinId: join.joinId });
    this.#order.set(ref, join.order);
    this.#present.set(ref, join.present);
    if (join.parent) {
      this.#further.add(ref);
      this.#parents.set(ref, `${join.senderId} ${join.parent}`);
    }
  }

  #open(message: LiveMessage): OpenedLiveMessage {
    return openLiveMessage({
      binding: this.#binding,
      trust: this.#ports.ctx.trust,
      listed: (header) => this.#joins.listed(header),
      message,
    });
  }

  #receivePresence(message: LiveMessage): void {
    const ref = { senderId: message.senderId, joinId: message.joinId };
    if (key(ref) === key(this.#me)) return;
    let opened: OpenedLiveMessage;
    try {
      opened = this.#open(message);
    } catch {
      // A presence that doesn't open counts as not visible and not failing.
      this.#presence.set(key(ref), { visible: false, saveFailing: null, shown: null });
      return;
    }
    if (this.#joins.check(opened).kind !== 'take') {
      this.#presence.set(key(ref), { visible: false, saveFailing: null, shown: null });
      return;
    }
    this.#verified.add(key(ref));
    this.#presence.set(key(ref), readPresence(opened.content));
  }

  #receive(stored: liveRoutes.StoredMessage): void {
    if (this.#status.state.kind !== 'live') return;
    if (stored.position > this.#position) this.#position = stored.position;
    let opened: OpenedLiveMessage;
    let decoded: DecodedUpdate | undefined;
    try {
      opened = this.#open(stored.message);
      if (opened.kind === 'update') decoded = decodeUpdate(opened.content);
      else if (opened.kind === 'snapshot') {
        const read = readSnapshot(opened.content);
        // One already in the session never applies a later snapshot: a newer format changes nothing here.
        decoded =
          read.kind === 'newer-format'
            ? { structs: [], deletes: new Map() }
            : decodeUpdate(read.state);
      }
    } catch (error) {
      if (error instanceof CryptoError) {
        return this.#stop(`a message was refused: ${error.message}`, null, false);
      }
      throw error;
    }
    this.#take({ stored, opened, decoded, since: Date.now(), reason: 'gap' });
  }

  // Take a message if it fits now, hold it if it waits, and then whatever
  // it held up.
  #take(held: Held): void {
    // A gone join whose changes a fold put in (section 5.10, **Serving and
    // relaying**): what the server relays of it later is dropped, unplaced,
    // for any join of this app in the session, the backlog it joins with too.
    const client = this.#joins.clientOf({
      senderId: held.opened.senderId,
      joinId: held.opened.joinId,
    });
    const range =
      client === undefined
        ? undefined
        : (this.#ignoring.get(client) ?? this.#foldedGone.get(client));
    if (range && held.opened.kind === 'update') {
      const own = (held.decoded?.structs ?? []).filter((structs) => structs.client === client);
      const start = Math.min(...own.map((structs) => structs.start));
      const end = Math.max(...own.map((structs) => structs.end));
      // What it sent before it went goes in as any message does; what the fold put in is dropped.
      if (own.length > 0 && end > range.from) {
        if (start >= range.from && end <= range.to) return this.#taken(held.stored.position);
        return this.#stop(
          'a join whose changes were folded in after it went sent more',
          null,
          false,
        );
      }
    }
    const verdict = this.#joins.check(held.opened, held.decoded);
    switch (verdict.kind) {
      case 'repeat':
        this.#taken(held.stored.position);
        return;
      case 'hold':
        this.#held.push({ ...held, reason: verdict.reason });
        this.#armHold();
        return;
      case 'refuse':
        return this.#stop(`a message was refused: ${verdict.why}`, null, false);
      case 'equivocation':
        return this.#stop('someone sent two messages under one number', null, false);
      case 'take':
        break;
    }
    const { opened, stored } = held;
    if (opened.kind === 'update' && this.#further.has(key(opened))) {
      // The change of a second grant for a revision whose fold was placed is never placed.
      for (const grant of this.#grants.values()) {
        if (grant.position !== stored.position) continue;
        const first = this.#placedAt.get(grant.subject);
        if (first && first.position !== stored.position) {
          return this.#stop('a change from outside was folded in twice', null, false);
        }
      }
    }
    if (opened.kind === 'update') {
      // An edit the editor hasn't reported yet goes in first, on the text it was made on.
      if (key(opened) !== key(this.#me)) {
        for (const listener of this.#beforeRemote) {
          try {
            listener();
          } catch {
            // A listener's own failure stays its own.
          }
        }
      }
      // Known before it is placed, as a note it places counts by it.
      if (this.#further.has(key(opened)) && held.decoded) {
        this.#furtherUpdates.set(stored.position, { join: key(opened), decoded: held.decoded });
        // A fold's update is wanted only until its grant line and notice: the latest few.
        for (const old of [...this.#furtherUpdates.keys()].slice(0, -64)) {
          this.#furtherUpdates.delete(old);
        }
      }
      const misplaced = this.document.apply(opened.content, REMOTE_ORIGIN);
      if (misplaced.length > 0) {
        return this.#stop(
          `someone’s change doesn’t fit the page: ${misplaced[0]?.why}`,
          null,
          false,
        );
      }
      const ref = { senderId: opened.senderId, joinId: opened.joinId };
      const changes =
        (held.decoded?.structs.length ?? 0) > 0 || (held.decoded?.deletes.size ?? 0) > 0;
      if (changes && !this.#further.has(key(ref))) this.#typed.add(opened.senderId);
      // This app's own were counted as they were sealed.
      if (key(ref) !== key(this.#me)) {
        this.#bytesSinceSnapshot += stored.message.sealed.ciphertext.length;
      }
      // Only an update makes a session unsaved, for the server: a Saved notice never does.
      this.#lastUpdate = Math.max(this.#lastUpdate, stored.position);
      // A further join's, which may be a fold's grant placed (section 5.10, **Saving**).
      if (this.#further.has(key(ref)) && held.decoded) {
        for (const notice of [...this.#foldNotices.values()]) {
          if (this.#grants.get(notice.revision)?.position === stored.position) {
            queueMicrotask(() => this.#foldNotice(notice.revision, notice.join, notice.state));
          }
        }
      }
    } else if (opened.kind === 'saved') {
      try {
        const read = readSaved(opened.content);
        if (read.kind === 'current' && this.#further.has(key(opened))) {
          const state = decodeState(read.state);
          if (state) this.#foldNotice(read.revisionId, key(opened), state);
        }
      } catch (error) {
        if (error instanceof CryptoError) {
          return this.#stop(`a Saved notice was refused: ${error.message}`, null, false);
        }
        throw error;
      }
      // A hint: what counts is the draft's own `wikistow.live`, opened next.
      void this.#learnHead();
    }
    // Someone else's later snapshot: the next is due from here.
    if (opened.kind === 'snapshot' && key(opened) !== key(this.#me)) this.#bytesSinceSnapshot = 0;
    this.#joins.take(opened);
    this.#verified.add(key(opened));
    this.#taken(stored.position);
    // What it held up may fit now.
    const waiting = this.#held;
    this.#held = [];
    for (const next of waiting) this.#take(next);
  }

  #taken(position: number): void {
    queueMicrotask(() => this.#trailSoon());
    const lowestHeld = Math.min(...this.#held.map((held) => held.stored.position));
    this.#covers = Number.isFinite(lowestHeld)
      ? Math.max(this.#covers, lowestHeld - 1)
      : Math.max(this.#covers, position);
  }

  #armHold(): void {
    if (this.#holdTimer) return;
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      const now = Date.now();
      const late = this.#held.find(
        (held) => now - held.since >= HOLD_MS && this.#present.get(key(held.opened)) !== false,
      );
      if (late) return this.#stop('messages from someone in the session never came', null, true);
      if (this.#held.length > 0) this.#armHold();
    }, HOLD_MS / 3);
  }

  #setHead(head: RevisionId | null): void {
    if (head === this.#head) {
      this.#staleSince = null;
      return;
    }
    // A draft the head descends from: a line sent before the head moved, as
    // after this app's own save. Named for 30 s, it is a rollback.
    if (head && this.#ancestors.has(head)) {
      this.#staleSince ??= Date.now();
      if (Date.now() - this.#staleSince < HOLD_MS) return;
      this.#head = head;
      return this.#stop('the server served an older version of this page', head, false);
    }
    this.#staleSince = null;
    this.#head = head;
    if (this.#outsiderSince && this.#outsiderSince.head !== head) this.#outsiderSince = null;
    void this.#learnHead();
  }

  #ended(reason: 'access' | 'ended' | 'deleted'): void {
    this.#stopSending = true;
    this.#close({ kind: 'ended', reason });
  }

  // ---- Drafts and checking the saver ----

  /**
   * Open the draft head if it is new to this app, at most every 10 s, and
   * see whether it is the session's: its `wikistow.live` names it and the
   * session, its signer is a person with a join this app took a message
   * from, and it is under the record's key material.
   */
  async #learnHead(force = false): Promise<void> {
    const head = this.#head;
    if (this.#opening) {
      await this.#opening;
      if (this.#head !== head) return this.#learnHead(force);
    }
    if (!head || this.#drafts.has(head) || this.#outsiders.has(head)) {
      this.#compare();
      return;
    }
    const wait = this.#lastCheckAt + CHECK_MS - Date.now();
    if (!force && wait > 0 && this.#drafts.size > 0) {
      if (!this.#checkTimer) {
        this.#checkTimer = setTimeout(() => {
          this.#checkTimer = null;
          void this.#learnHead();
        }, wait);
      }
      return;
    }
    this.#lastCheckAt = Date.now();
    this.#opening = this.#openHead(head).finally(() => {
      this.#opening = null;
    });
    await this.#opening;
    if (this.#head && this.#outsiders.has(this.#head)) {
      // A draft written outside the session: the saver folds it in (ADR 0015 decision 8).
      void this.#fromOutside(this.#head);
      this.#update();
      return;
    }
    const seen = this.#head ? this.#drafts.get(this.#head) : undefined;
    // A session draft its later drafts descend from, served as head again, is a rollback.
    if (seen && this.#ancestors.has(seen.revisionId)) {
      return this.#stop('the server served an older version of this page', seen.revisionId, false);
    }
    if (seen) this.#sawHead(seen);
    // A save waiting for the head can go now; and the 20 s a save may wait start again.
    const opened = this.#drafts.get(head);
    if (opened && this.#head === head) {
      try {
        this.#unsavedSince = holdsState(opened.state, this.document.state()) ? null : Date.now();
      } catch {
        // A state Yjs wrote: it decodes.
      }
    }
    this.#compare();
    this.#scheduleSave();
    this.#update();
    if (this.#head !== head) void this.#learnHead();
  }

  /** Open the head now, if it is new, as a save that must run at once needs it. */
  async #ensureHead(): Promise<void> {
    const head = this.#head;
    if (head && !this.#drafts.has(head) && !this.#outsiders.has(head)) await this.#learnHead(true);
  }

  /**
   * Open the draft `head` and file it as the session's or an outsider's.
   * A signer this app hasn't yet taken a message from is given 30 s, as
   * their join's messages may still be on the way.
   */
  async #openHead(head: RevisionId): Promise<void> {
    let draft: OpenedDraft;
    try {
      draft = await this.#ports.openDraft(head);
    } catch {
      return;
    }
    this.#basedOn.set(head, draft.basedOn);
    if (ofAnotherSession(draft, this.sessionId)) {
      // The server should have ended this session before another saved (section 5.10, **Saving**).
      return this.#stop('this page was saved by another live session', null, false);
    }
    const state = sessionState(draft.payload, draft.revisionId, this.sessionId);
    const signer = [...this.#verified].some((join) => join.startsWith(`${draft.authorId} `));
    const ours = state !== null && !isAgentId(draft.authorId) && sameKeys(draft, this.#opened);
    if (!ours || !state) {
      // Counted already, as a fold placed without a save.
      if (this.#drafts.has(head)) return;
      this.#outsiders.add(head);
      this.#outsiderDrafts.set(head, draft);
      // Drafts from outside are wanted while they are head or a fold's base: the latest few.
      for (const old of [...this.#outsiderDrafts.keys()].slice(0, -16)) {
        if (old !== this.#head) this.#outsiderDrafts.delete(old);
      }
      return;
    }
    if (!signer) {
      const since = (this.#unknownSigner ??= { head, at: Date.now() });
      if (since.head !== head) this.#unknownSigner = { head, at: Date.now() };
      else if (Date.now() - since.at > HOLD_MS) {
        // Claiming typing of joins still here, this app just hasn't been sent it:
        // folding it would put that typing in twice. It can't catch up instead.
        const held = this.document.state().vector;
        const present = [...state.vector].some(([client, clock]) => {
          const join = this.#joins.joinOf(client);
          const lacking = (held.get(client) ?? 0) < clock;
          // Under a client no join it knows derives, or a join still here: it can't catch up.
          return lacking && (join === undefined || this.#present.get(key(join)) !== false);
        });
        if (present)
          return this.#stop('messages from someone in the session never came', null, true);
        // A session draft as it was, its signer's typing gone: folded as a gone join's is.
        const gone = [...state.vector].flatMap(([client, clock]) =>
          (held.get(client) ?? 0) < clock ? [client] : [],
        );
        const filed: SessionDraft = {
          revisionId: head,
          payload: draft.payload,
          state,
          compared: false,
          with: withOf(draft.payload),
          openedAt: Date.now(),
          opened: draft,
        };
        this.#asOutsider(filed, draft, gone);
        return;
      } else if (!this.#checkTimer && this.#status.state.kind === 'live') {
        this.#lastCheckAt = 0;
        this.#checkTimer = setTimeout(() => {
          this.#checkTimer = null;
          void this.#learnHead();
        }, 2_000);
      }
      return;
    }
    // One this app saved itself, and so compared, stays as it is.
    if (this.#drafts.has(head)) return;
    this.#drafts.set(head, {
      revisionId: head,
      payload: draft.payload,
      state,
      compared: false,
      with: withOf(draft.payload),
      openedAt: Date.now(),
      opened: draft,
    });
  }

  #unknownSigner: { head: RevisionId; at: number } | null = null;
  // Since when the stream has named only a draft the head descends from.
  #staleSince: number | null = null;

  /**
   * When the document has exactly the head draft's state, compare the
   * payload it would write with the draft's (section 5.10, **Saving**): a
   * draft that differs takes the session out of step, and this app saves
   * its own document over it in the open.
   */
  #compare(): void {
    const head = this.#head && this.#drafts.get(this.#head);
    if (!head || head.compared) return;
    let state: LiveState;
    try {
      state = this.document.state();
    } catch {
      return;
    }
    if (!sameState(state, head.state)) {
      // Changes it claims whose sender's join went without sending them: a
      // draft from outside, folded in (section 5.10, **Saving**).
      // Its fold is placed: it counts as the fold's notice says, so wait for that.
      const placed = this.#placedAt.get(head.revisionId);
      if (placed && !head.foldedBy && !holdsState(state, head.state)) {
        if (Date.now() - placed.at > HOLD_MS) {
          return this.#stop(
            'a change folded in from outside never said it was saved',
            null,
            true,
            true,
          );
        }
        if (!this.#noticeTimer) {
          this.#noticeTimer = setTimeout(() => {
            this.#noticeTimer = null;
            this.#compare();
          }, 2_000);
        }
        return;
      }
      const gone = holdsState(state, head.state) ? null : this.#goneFrom(head, state);
      if (gone && head.opened) return this.#asOutsider(head, head.opened, gone);
      const again = [...head.state.vector].some(
        ([client, clock]) =>
          this.#foldedGone.has(client) && (state.vector.get(client) ?? 0) < clock,
      );
      if (again) {
        // Once, it joins again; a join made for that which still can't catch up ends the session.
        const twice = cantCatchUp.has(this.sessionId);
        cantCatchUp.add(this.sessionId);
        return this.#stop('this app can’t catch up with the others', null, !twice, twice);
      }
      // The 30 s rule: a draft whose state this app still doesn't hold.
      if (!holdsState(state, head.state) && Date.now() - head.openedAt > HOLD_MS) {
        this.#stop('the saved page claims changes that never came', null, false);
      }
      return;
    }
    let equal: boolean;
    try {
      equal = samePayload(this.document.payload(head.payload), head.payload);
    } catch {
      equal = false;
    }
    if (!equal && head.foldedBy) {
      // Folded without a save: its grant's holder, not the outsider who
      // signed it, has shown itself dishonest; nobody saves over that draft.
      return this.#stop(
        'the live page differs from the change folded in from outside it',
        null,
        false,
      );
    }
    if (!equal) {
      // A provisional newcomer saves nothing over it: its snapshot may be what's wrong.
      // A provisional newcomer can't take part, and ends the session; any
      // other app saves its own document over the draft, and joins again.
      return this.#provisional
        ? this.#stop('the saved page differs from what everyone typed', null, false, true)
        : this.#stop('the saved page differs from what everyone typed', head.revisionId, true);
    }
    head.compared = true;
    this.#checked = head.revisionId;
    this.#provisional = false;
    // Caught up: a later time it can't is a first time again.
    cantCatchUp.delete(this.sessionId);
    this.#update();
  }

  // ---- Drafts from outside the session (ADR 0015 decision 8) ----

  // The clients of the changes `draft` claims that `state` lacks, when each
  // is a join that has gone; null otherwise.
  #goneFrom(
    draft: SessionDraft,
    state: LiveState,
    /** Joins whose changes a fold put in count too, as for counting that fold. */
    { folded = false }: { folded?: boolean } = {},
  ): number[] | null {
    const clients = new Set<number>();
    for (const [client, clock] of draft.state.vector) {
      if ((state.vector.get(client) ?? 0) < clock) clients.add(client);
    }
    for (const [client, ranges] of draft.state.deletes) {
      const one = { vector: new Map<number, number>(), deletes: new Map([[client, ranges]]) };
      if (!holdsState(state, one)) clients.add(client);
    }
    if (clients.size === 0) return null;
    for (const client of clients) {
      // Its changes were folded in once already: putting them in again would
      // copy the text each time. This app can't catch up instead.
      if (!folded && this.#foldedGone.has(client)) return null;
      const join = this.#joins.joinOf(client);
      if (!join || this.#present.get(key(join)) !== false) return null;
    }
    return [...clients];
  }

  // Joins whose changes a draft claims but that went without sending them, by that draft.
  readonly #goneJoins = new Map<RevisionId, number[]>();
  // Gone joins' clients whose changes this app's fold is putting in now, and
  // the range of each client's clocks it puts in: what it lacked of the draft's claims.
  readonly #ignoring = new Map<number, GoneRange>();
  readonly #goneRanges = new Map<RevisionId, Map<number, GoneRange>>();
  // Gone joins' clients the fold running now drops, until it places its change.
  #unplaced = new Map<number, GoneRange>();
  // The clients of gone joins whose changes a fold put in: once is all (A2),
  // for every join of this app in the session, so joining again forgets nothing.
  get #foldedGone(): Map<number, GoneRange> {
    let clients = foldedGone.get(this.sessionId);
    if (!clients) foldedGone.set(this.sessionId, (clients = new Map()));
    return clients;
  }

  // A session draft holding changes of joins gone without sending them: from outside, folded in.
  #asOutsider(draft: SessionDraft, opened: OpenedDraft, gone: number[]): void {
    this.#drafts.delete(draft.revisionId);
    this.#outsiders.add(draft.revisionId);
    this.#outsiderDrafts.set(draft.revisionId, opened);
    this.#goneJoins.set(draft.revisionId, gone);
    this.#goneRanges.set(
      draft.revisionId,
      new Map(
        gone.map((client) => [
          client,
          {
            from: Y.getState(this.document.doc.store, client),
            to: draft.state.vector.get(client) ?? Y.getState(this.document.doc.store, client),
          },
        ]),
      ),
    );
    if (this.#lastHead?.revisionId === draft.revisionId) {
      const before = opened.basedOn;
      const parent = before ? this.#drafts.get(before) : undefined;
      // Without its parent here, the last one seen before stays the bar.
      this.#lastHead = parent ?? this.#lastHeadBefore ?? null;
    }
    if (this.#checked === draft.revisionId && opened.basedOn) this.#checked = opened.basedOn;
    void this.#fromOutside(draft.revisionId);
  }

  // A draft this app saved on `basedOn`, seen as head when it is.
  #seenOwn(revisionId: RevisionId, basedOn: RevisionId): void {
    this.#basedOn.set(revisionId, basedOn);
    const draft = this.#drafts.get(revisionId);
    if (draft && this.#head === revisionId) this.#sawHead(draft);
  }

  /**
   * Whether `theirs`, or a draft between it and `base` by signed `basedOn`,
   * is a session's draft (its own `wikistow.live`), of this session or an
   * earlier one: one whose sender went, or wasn't heard. It holds the
   * session's typing as it was, so its fold, and Review of its note, take
   * both sides adding at one place as an overlap, never both.
   */
  async #sessionDraftIn(theirs: OpenedDraft, base: RevisionId | null): Promise<boolean> {
    let draft: OpenedDraft | null = theirs;
    for (let steps = 0; draft && draft.revisionId !== base && steps < 256; steps++) {
      if (draftLive(draft.payload, draft.revisionId).kind === 'live') return true;
      const next: RevisionId | null = draft.basedOn;
      if (!next || next === base) return false;
      try {
        draft = this.#outsiderDrafts.get(next) ?? (await this.#ports.openDraft(next));
      } catch {
        return false;
      }
    }
    return false;
  }

  // Whether `ancestor` is in `revision`'s signed `basedOn` chain, as this app has read it.
  #chainHas(revision: RevisionId, ancestor: RevisionId): boolean {
    let at = this.#basedOn.get(revision) ?? null;
    for (let steps = 0; at && steps < 256; steps++) {
      if (at === ancestor) return true;
      at = this.#basedOn.get(at) ?? null;
    }
    return false;
  }

  #lastHeadBefore: SessionDraft | null = null;

  // A session draft is head: what it descends from can't be head again.
  #sawHead(draft: SessionDraft): void {
    if (!this.#lastHead || holdsState(draft.state, this.#lastHead.state)) {
      if (this.#lastHead !== draft) this.#lastHeadBefore = this.#lastHead;
      this.#lastHead = draft;
    }
    for (
      let at = this.#basedOn.get(draft.revisionId) ?? null;
      at && !this.#ancestors.has(at);
      at = this.#basedOn.get(at) ?? null
    ) {
      this.#ancestors.add(at);
    }
  }

  // A fold grant, as the server told of it: who holds it, and once placed, where.
  #grant(grant: liveRoutes.Grant): void {
    const first = this.#placedAt.get(grant.subject);
    const subject = RevisionId.safeParse(grant.subject);
    if (grant.position !== null && subject.success && this.#ownSessionDraft(subject.data)) {
      // A fold of a draft of the session: its holder shows itself dishonest.
      return this.#stop(
        'someone folded in a draft of this session as if from outside',
        null,
        false,
      );
    }
    if (grant.position !== null) {
      if (first && first.position !== grant.position) {
        // A second fold of one revision: its change would put theirs in twice.
        return this.#stop('a change from outside was folded in twice', null, false);
      }
      if (!first) this.#placedAt.set(grant.subject, { position: grant.position, at: Date.now() });
    }
    const known = this.#grants.get(grant.subject);
    // A newer grant, or the same one moved on.
    if (known && Date.parse(known.grantedAt) > Date.parse(grant.grantedAt)) return;
    this.#grants.set(grant.subject, grant);
    const revision = RevisionId.safeParse(grant.subject);
    if (!revision.success) return;
    if (grant.position !== null) {
      this.#folded.add(revision.data);
      // A note its update placed before this line came counts now.
      const id = revision.data;
      if (this.#status) queueMicrotask(() => this.#noteChanged(id));
    }
    // A Saved notice that came first.
    for (const notice of [...this.#foldNotices.values()]) {
      if (notice.revision === revision.data) {
        this.#foldNotice(notice.revision, notice.join, notice.state);
      }
    }
    if (grant.lapsed && this.#head === revision.data && this.#status) {
      void this.#fromOutside(revision.data);
    }
  }

  /**
   * The draft head is one written outside the session (ADR 0015 decision
   * 8). The saver folds it in once it holds the server's grant, and any app
   * may once it has waited 20 s; the others wait for the fold's change. A
   * head the session's drafts descend from, or that descends from none of
   * them, would bring back what the session deleted, and one under other
   * keys can't be the session's: this app leaves and says so.
   */
  async #fromOutside(head: RevisionId): Promise<void> {
    if (this.#folding) return this.#armFold();
    if (this.#leaving || !this.#keyed() || this.#head !== head) return;
    const draft = this.#outsiderDrafts.get(head);
    if (this.#ancestors.has(head)) {
      return this.#stop('the server served an older version of this page', head, false);
    }
    if (this.#outsiderSince?.head !== head) this.#outsiderSince = { head, at: Date.now() };
    // Its fold is placed: its change and Saved notice are on their way.
    if (!draft || this.#folded.has(head)) {
      this.#foldWithoutNotice(head);
      return this.#armFold();
    }
    if (!sameKeys(draft, this.#opened)) {
      return this.#stop(
        'this page was saved from outside the live session under other keys',
        null,
        false,
      );
    }
    const saver = this.#saver();
    const mine = saver !== null && key(saver) === key(this.#me);
    const grant = this.#grants.get(head);
    const othersHold =
      grant !== undefined &&
      !grant.lapsed &&
      grant.position === null &&
      key(grant.holder) !== key(this.#me);
    const waited = Date.now() - this.#outsiderSince.at >= TAKE_OVER_MS;
    if ((!mine && !waited) || othersHold) return this.#armFold();
    const run: Promise<void> = this.#fold(head, draft)
      .catch(() => this.#armFold())
      .finally(() => {
        if (this.#folding === run) this.#folding = null;
        // A fold that placed nothing drops nothing of a gone join after all.
        for (const client of this.#unplaced.keys()) this.#ignoring.delete(client);
        this.#unplaced = new Map();
      });
    this.#folding = run;
    void this.#tracked(run);
    await run;
  }

  /**
   * A fold placed without a save counts only once its holder's Saved
   * notice names it (section 5.10, **Saving**), since the grant and its
   * position are the server's word. One whose notice hasn't come in 30 s
   * means this app can't catch up: it leaves, and goes on outside the
   * session from the head, so a missing notice can't hold its typing
   * unsaved for good.
   */
  #foldWithoutNotice(head: RevisionId): void {
    const grant = this.#grants.get(head);
    const placed = this.#placedAt.get(head);
    if (!grant || grant.position === null || !placed) return;
    if (Date.now() - placed.at < HOLD_MS || this.#drafts.get(head)?.foldedBy) return;
    // Nobody can save over it, and the server grants it no second fold: the
    // session ends, so the next starts from the head (section 5.10, **Saving**).
    this.#stop('a change folded in from outside never said it was saved', null, true, true);
  }

  // Look at a draft from outside again soon: its grant may lapse, or its fold arrive.
  #armFold(): void {
    if (this.#foldTimer || !this.#keyed()) return;
    this.#foldTimer = setTimeout(() => {
      this.#foldTimer = null;
      const head = this.#head;
      if (head && this.#outsiders.has(head)) void this.#fromOutside(head);
    }, 2_000);
  }

  /**
   * The latest session draft `draft` descends from, by signed `basedOn`,
   * which a fold merges from; 'rollback' when it descends from none this
   * app can find; null when one couldn't be opened just now.
   */
  async #foldBase(
    draft: OpenedDraft,
  ): Promise<SessionDraft | 'rollback' | 'other-session' | 'too-far' | null> {
    let at = draft.basedOn;
    for (let steps = 0; at; steps++) {
      if (steps >= 256) return 'too-far';
      // A draft filed as from outside, as one claiming a gone join's changes, is walked past.
      const known = this.#outsiders.has(at) ? undefined : this.#drafts.get(at);
      if (known) return known;
      if (this.#outsiders.has(at)) {
        at = this.#basedOn.get(at) ?? this.#outsiderDrafts.get(at)?.basedOn ?? null;
        continue;
      }
      let opened: OpenedDraft;
      try {
        opened = this.#outsiderDrafts.get(at) ?? (await this.#ports.openDraft(at));
      } catch {
        return null;
      }
      this.#basedOn.set(at, opened.basedOn);
      if (ofAnotherSession(opened, this.sessionId)) return 'other-session';
      const state = sessionState(opened.payload, at, this.sessionId);
      const signer = [...this.#verified].some((join) => join.startsWith(`${opened.authorId} `));
      if (state && signer && !isAgentId(opened.authorId) && sameKeys(opened, this.#opened)) {
        const found: SessionDraft = {
          revisionId: at,
          payload: opened.payload,
          state,
          compared: false,
          with: withOf(opened.payload),
          openedAt: Date.now(),
          opened,
        };
        this.#drafts.set(at, found);
        return found;
      }
      at = opened.basedOn;
    }
    return 'rollback';
  }

  /** Ask for the fold grant of `revision` with the main join's next request. */
  #askGrant(revision: RevisionId): Promise<liveRoutes.Grant | null> {
    this.#foldAsk?.answer(null);
    return new Promise((answer) => {
      this.#foldAsk = { revision, answer };
      this.#schedule();
    });
  }

  /**
   * Fold the outsider's `draft`, the head, into the session (section 5.10,
   * **Saving**): merged with ADR 0013's merge from the latest session draft
   * it descends from, the session's text kept where both changed one part
   * and the part noted for Review; made in a copy under a further join,
   * saved on top of it, unless the session changed nothing since and the
   * outsider's draft is what the document then writes; and sent once that
   * lands, with the grant, and a Saved notice after it.
   */
  async #fold(head: RevisionId, draft: OpenedDraft): Promise<void> {
    const base = await this.#foldBase(draft);
    if (base === null) return this.#armFold();
    if (base === 'rollback') {
      return this.#stop('this page’s draft doesn’t come from the live session’s', head, false);
    }
    if (base === 'other-session') {
      return this.#stop('this page was saved by another live session', null, false);
    }
    if (base === 'too-far') {
      return this.#stop(
        'too many saves came from outside the live session to fold in',
        null,
        false,
      );
    }
    if (!holdsState(this.document.state(), base.state)) {
      // Its changes may still be on their way: given 30 s, as any draft is.
      const since = this.#outsiderSince;
      if (since?.head === head && Date.now() - since.at < HOLD_MS) return this.#armFold();
      return this.#stop(
        'the page was saved from outside on changes this app doesn’t have',
        null,
        false,
      );
    }
    // A newcomer that never saw an earlier fold doesn't fold it again.
    if (this.#lastHead && !holdsState(base.state, this.#lastHead.state)) {
      return this.#stop('the server served an older version of this page', head, false);
    }
    await this.flush();
    if (!this.#keyed()) return;
    if (this.#head !== head || this.#pending.length > 0 || this.#queue.length > 0) {
      return this.#armFold();
    }
    const grant = await this.#askGrant(head);
    if (!grant || grant.lapsed || grant.position !== null || key(grant.holder) !== key(this.#me)) {
      return this.#armFold();
    }
    if (
      !this.#keyed() ||
      this.#head !== head ||
      this.#pending.length > 0 ||
      this.#queue.length > 0 ||
      this.#placing
    ) {
      return this.#armFold();
    }
    // A gone join's changes about to go in, of drafts not folded yet, and the
    // clocks of each that the fold puts in: dropped from now on, unless it doesn't.
    const goneNow = new Map<number, GoneRange>();
    for (const [revision, clients] of this.#goneJoins) {
      if (this.#folded.has(revision)) continue;
      if (revision !== head && !this.#chainHas(head, revision)) continue;
      for (const client of clients) {
        const range = this.#goneRanges.get(revision)?.get(client);
        if (range && !this.#ignoring.has(client)) goneNow.set(client, range);
      }
    }
    for (const [client, range] of goneNow) this.#ignoring.set(client, range);
    this.#unplaced = goneNow;
    const goneMode = await this.#sessionDraftIn(draft, base.revisionId);
    if (!this.#keyed() || this.#head !== head) return this.#armFold();
    const before = this.document.state();
    let folded: Folded;
    try {
      // A session draft's in it, as Review of its note works out too.
      folded = foldPayloads(base.payload, this.#payload(base.payload), draft.payload, {
        gone: goneMode,
      });
    } catch {
      return this.#stop(
        'this app couldn’t merge a change made outside the live session',
        null,
        false,
      );
    }
    const ctx = this.#ports.ctx;
    const further = newId(JoinId);
    const clientId = liveClientId({
      installationId: ctx.installationId,
      sessionId: this.sessionId,
      senderId: ctx.identity.public.id,
      senderKeyVersion: ctx.identity.public.keyVersion,
      joinId: further,
    });
    const copy = new LiveDocument(clientId);
    if (copy.apply(Y.encodeStateAsUpdate(this.document.doc), 'copy').length > 0) {
      return this.#armFold();
    }
    const covers = this.#covers;
    const updates: Uint8Array[] = [];
    copy.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN) updates.push(update);
    });
    const misplaced = copy.edit(() => {
      writeTarget(copy, folded.target);
      if (folded.parts.length > 0) {
        copy.map('overlaps').set(head, JSON.stringify({ revision: head, parts: folded.parts }));
      }
    }, LOCAL_ORIGIN);
    if (misplaced.length > 0) {
      return this.#stop(
        'this app couldn’t merge a change made outside the live session',
        null,
        false,
      );
    }
    const update = updates.length > 0 ? Y.mergeUpdates(updates) : new Uint8Array([0, 0]);
    const written = this.#payload(draft.payload, copy);
    // Nothing of the session's since the base, and theirs is what the document then writes.
    const unsaved = !sameState(before, base.state) || !samePayload(written, draft.payload);
    const people = [...new Set<IdentityId>([...base.with, ...this.#typed, draft.authorId])];
    const stateBytes = copy.stateBytes();
    const copyState = copy.state();
    const seal = (seq: number, kind: 'update' | 'saved', clock: number, content: Uint8Array) =>
      this.#seal({ kind, joinId: further, seq, clock, content });
    const send = (message: LiveMessage, extra: { covers?: number; fold?: RevisionId } = {}) =>
      this.#sendAgain({
        joinId: further,
        parent: this.#me.joinId,
        messages: [{ message, ...(extra.covers !== undefined && { covers: extra.covers }) }],
        ...(extra.fold && { fold: extra.fold }),
      });
    let saved: { revisionId: RevisionId; payload: PagePayload } | null = null;
    const clock = Y.getState(copy.doc.store, clientId);
    let placing: LiveMessage;
    try {
      // Sealed before the save, so one too large to send is never saved.
      placing = seal(2, 'update', clock, update);
    } catch {
      return this.#stop(
        'a change made outside the live session is too large to fold in',
        null,
        false,
      );
    }
    try {
      await send(seal(1, 'update', 0, new Uint8Array([0, 0])));
      if (!this.#keyed()) return;
      if (unsaved) {
        const revisionId = newId(RevisionId);
        saved = await this.#whileAlive(further, () =>
          this.#ports.saveDraft({
            basedOn: head,
            revisionId,
            payload: withLive(written, {
              revision: revisionId,
              session: this.sessionId,
              state: stateBytes,
              with: people,
            }),
            linkChoices: this.#linkChoices(copy),
          }),
        );
      }
    } catch {
      // Nothing of it went to anyone: a refused save leaves nothing behind.
      void this.#transport.leave(further).catch(() => {});
      return this.#armFold();
    }
    if (!this.#keyed()) {
      void this.#transport.leave(further).catch(() => {});
      return;
    }
    this.#placing = true;
    try {
      this.#folded.add(head);
      if (folded.parts.length > 0) {
        this.#notes.set(head, {
          revision: head,
          parts: folded.parts,
          by: draft.authorId,
          carried: false,
        });
      }
      this.document.apply(update, COPY_ORIGIN);
      await send(placing, { fold: head });
      const revisionId = saved?.revisionId ?? head;
      this.#drafts.set(revisionId, {
        ours: true,
        revisionId,
        payload: saved?.payload ?? draft.payload,
        state: copyState,
        compared: saved ? samePayload(written, saved.payload) : true,
        with: people,
        openedAt: Date.now(),
        ...(!saved && { foldedBy: key(this.#me) }),
      });
      this.#outsiders.delete(head);
      // In once: never again, for any join of this app in the session.
      for (const [client, range] of goneNow) this.#foldedGone.set(client, range);
      this.#unplaced = new Map();
      if (saved && this.#head === head) this.#head = saved.revisionId;
      if (saved) this.#basedOn.set(saved.revisionId, head);
      if (this.#drafts.get(revisionId)?.compared) this.#checked = revisionId;
      const draftNow = this.#drafts.get(revisionId);
      if (draftNow && this.#head === revisionId) this.#sawHead(draftNow);
      if (!this.#keyed()) return;
      await send(seal(3, 'saved', clock, stateContent(revisionId, stateBytes)), { covers });
      void this.#transport.leave(further).catch(() => {});
    } catch {
      // The draft claims a change the others never got: the session can't go on with it.
      this.#stop('a change made outside the live session couldn’t be sent', null, true);
    } finally {
      this.#placing = false;
      this.#schedule();
      this.#update();
    }
  }

  /**
   * A Saved notice from a further join: if it names a draft from outside
   * whose grant that join's parent held and placed, the fold went in
   * without a save, and that draft counts as the session's, holding the
   * fold's base and the grant's change, worked out here the same as by
   * every app; one that claims otherwise doesn't count (section 5.10).
   */
  #foldNotice(revision: RevisionId, join: string, state: LiveState): void {
    const id = `${revision}\0${join}`;
    const grant = this.#grants.get(revision);
    if (!grant || grant.position === null) {
      // Most name a further join's own save, which no grant will: only the latest few wait.
      this.#foldNotices.set(id, { revision, join, state });
      for (const old of [...this.#foldNotices.keys()].slice(0, -32)) this.#foldNotices.delete(old);
      return;
    }
    if (this.#parents.get(join) !== key(grant.holder)) return void this.#foldNotices.delete(id);
    const placed = this.#furtherUpdates.get(grant.position);
    // Its change may still be on its way, held: the notice waits for it.
    if (!placed) return void this.#foldNotices.set(id, { revision, join, state });
    this.#foldNotices.delete(id);
    if (placed.join !== join || this.#drafts.get(revision)?.foldedBy) return;
    void this.#countFold(revision, grant, placed.decoded, state);
  }

  async #countFold(
    revision: RevisionId,
    grant: liveRoutes.Grant,
    decoded: DecodedUpdate,
    /** As its holder's Saved notice says. */
    noticed: LiveState,
  ): Promise<void> {
    let draft = this.#outsiderDrafts.get(revision);
    if (!draft) {
      try {
        draft = await this.#ports.openDraft(revision);
      } catch {
        return;
      }
      this.#basedOn.set(revision, draft.basedOn);
    }
    if (!sameKeys(draft, this.#opened)) return;
    const base = await this.#foldBase(draft);
    // One filed as a session draft before its join went counts now as the fold says.
    const existing = this.#drafts.get(revision);
    // Only one it filed as a session draft claiming what it lacks: never an honest one it holds.
    const replaceable =
      !existing ||
      (!existing.foldedBy &&
        !existing.compared &&
        !holdsState(this.document.state(), existing.state) &&
        (this.#goneJoins.has(revision) ||
          this.#goneFrom(existing, this.document.state(), { folded: true }) !== null));
    if (!base || typeof base === 'string' || !replaceable) return;
    const state = plusUpdate(base.state, decoded);
    if (!sameState(state, noticed)) return;
    this.#drafts.set(revision, {
      revisionId: revision,
      payload: draft.payload,
      state,
      compared: false,
      with: [...new Set([...base.with, draft.authorId])],
      openedAt: Date.now(),
      foldedBy: key(grant.holder),
    });
    this.#outsiders.delete(revision);
    this.#folded.add(revision);
    const counted = this.#drafts.get(revision);
    if (counted && this.#head === revision) this.#sawHead(counted);
    this.#compare();
    this.#scheduleSave();
    this.#update();
  }

  // ---- Notes and Review (ADR 0015 decision 8) ----

  // A draft this app counts as the session's by the ordinary rule: not one
  // folded in, from outside or as a gone join's.
  #ownSessionDraft(revision: RevisionId): boolean {
    const draft = this.#drafts.get(revision);
    if (!draft || draft.foldedBy || this.#goneJoins.has(revision)) return false;
    // One claiming changes of joins gone without sending them is from outside.
    return this.#goneFrom(draft, this.document.state(), { folded: true }) === null;
  }

  /**
   * An `overlaps` entry changed. A note counts only when placed by the
   * further join that held that revision's fold grant; after that, any
   * join may take parts out of it or delete it, never add parts or put
   * back one deleted (section 5.10, **The document**).
   */
  #noteChanged(changed: string): void {
    const parsed = RevisionId.safeParse(changed);
    if (!parsed.success || this.#notesGone.has(parsed.data)) return;
    const revision = parsed.data;
    const map = this.document.map('overlaps');
    const counted = this.#notes.get(revision);
    const text = map.get(revision);
    if (text === undefined) {
      if (!counted) return;
      this.#notes.delete(revision);
      this.#notesGone.add(revision);
      return this.#update();
    }
    const parts = noteParts(text, revision);
    if (!parts) return;
    if (counted) {
      const had = new Set(counted.parts);
      const narrower = parts.every((part) => had.has(part));
      if (narrower && parts.length < counted.parts.length) {
        this.#notes.set(revision, { ...counted, parts });
        this.#update();
      }
      return;
    }
    // Never one naming a draft this app counts as the session's (section 5.10, **The document**).
    if (this.#ownSessionDraft(revision)) return;
    const item = (map as unknown as { _map: Map<string, Y.Item> })._map.get(revision);
    const join = item ? this.#joins.joinOf(item.id.client) : undefined;
    const grant = this.#grants.get(revision);
    if (!join?.parent || !grant || grant.lapsed || key(join.parent) !== key(grant.holder)) return;
    if (join.senderId !== grant.holder.senderId) return;
    // The further join whose update placed the grant (section 5.10, **The document**).
    const placed = grant.position === null ? undefined : this.#furtherUpdates.get(grant.position);
    if (placed?.join !== key(join)) return;
    this.#notes.set(revision, {
      revision,
      parts,
      by: this.#outsiderDrafts.get(revision)?.authorId ?? null,
      carried: false,
    });
    if (!this.#outsiderDrafts.has(revision)) void this.#noteAuthor(revision);
    this.#update();
  }

  // Who signed a note's draft, for the page to name.
  async #noteAuthor(revision: RevisionId): Promise<void> {
    try {
      const draft = await this.#ports.openDraft(revision);
      const note = this.#notes.get(revision);
      if (!note) return;
      this.#notes.set(revision, { ...note, by: draft.authorId });
      this.#update();
    } catch {
      // Named as someone, until it opens.
    }
  }

  /**
   * Notes the document held as it was built, which count when the draft
   * its snapshot names, a session draft signed by a person, carries them
   * too (section 5.10, **The document**); the first snapshot's are carried
   * from an earlier session.
   */
  async #countCarried(): Promise<void> {
    if (this.#snapshotNotes.size === 0) return;
    let draft: OpenedDraft;
    try {
      draft = await this.#ports.openDraft(this.#snapshotDraft);
    } catch {
      return;
    }
    if (isAgentId(draft.authorId)) return;
    const first = this.#snapshotDraft === this.#opened.payload.revisionId;
    // A session draft only, of an earlier session for the first snapshot's.
    if (first && draftLive(draft.payload, draft.revisionId).kind !== 'live') return;
    const parsed = OverlapsExtension.safeParse(draft.payload.extensions[OVERLAPS_NAMESPACE]);
    if (!parsed.success) return;
    for (const [revision, text] of this.#snapshotNotes) {
      const id = RevisionId.safeParse(revision);
      if (!id.success || this.#notes.has(id.data) || this.#notesGone.has(id.data)) continue;
      const parts = noteParts(text, id.data);
      const carried = parsed.data.revisions.find((entry) => entry.revision === id.data);
      if (!parts || !carried || !sameParts(parts, carried.parts)) continue;
      // Still as it was built: a later change took parts out, or deleted it.
      const now = this.document.map('overlaps').get(revision);
      const left = now === undefined ? null : noteParts(now, id.data);
      if (!left) continue;
      this.#notes.set(id.data, {
        revision: id.data,
        parts: left.filter((part) => parts.includes(part)),
        by: first ? draft.authorId : null,
        carried: first,
      });
      if (!first) void this.#noteAuthor(id.data);
    }
    this.#update();
  }

  /**
   * Open a note for Review (ADR 0015 decision 8): its draft, which must be
   * of this page, under the session's keys, not a draft of the session,
   * and descend from one, or, for a note carried from an earlier session,
   * be in the starting draft's own chain; the base the fold merged from;
   * and the document now. Null when it can't be opened as such.
   */
  async openNote(revision: RevisionId): Promise<OpenedNote | null> {
    const note = this.#notes.get(revision);
    if (!note) return null;
    let theirs: OpenedDraft;
    try {
      theirs = this.#outsiderDrafts.get(revision) ?? (await this.#ports.openDraft(revision));
    } catch {
      return null;
    }
    if (!sameKeys(theirs, this.#opened)) return null;
    // Not a draft of the session, but one folded in as from outside since its join went.
    // A draft naming this session only when it claims changes of joins gone without sending them.
    const claimed = sessionState(theirs.payload, revision, this.sessionId);
    if (claimed) {
      const known = this.#drafts.get(revision);
      const gone =
        this.#goneJoins.has(revision) ||
        known?.foldedBy !== undefined ||
        this.#goneFrom(
          {
            revisionId: revision,
            payload: theirs.payload,
            state: claimed,
            compared: false,
            with: [],
            openedAt: 0,
          },
          this.document.state(),
          { folded: true },
        ) !== null;
      if (!gone) return null;
    }
    let base: PagePayload | null = null;
    let goneMode = false;
    if (note.carried) {
      // In the starting draft's own chain: its base is the draft it was saved over.
      let at: RevisionId | null = this.#opened.payload.revisionId;
      for (let steps = 0; at && steps < 64 && at !== revision; steps++) {
        at = this.#basedOn.get(at) ?? (await this.#parentOf(at));
      }
      if (at !== revision || !theirs.basedOn) return null;
      try {
        base = (await this.#ports.openDraft(theirs.basedOn)).payload;
      } catch {
        return null;
      }
      goneMode = await this.#sessionDraftIn(theirs, theirs.basedOn);
    } else {
      const found = await this.#foldBase(theirs);
      if (!found || typeof found === 'string') return null;
      base = found.payload;
      goneMode = await this.#sessionDraftIn(theirs, found.revisionId);
    }
    // A part naming a namespace the document never holds is ignored.
    const namespaces = namespacesOf(theirs.payload);
    const parts = note.parts.filter((part) => {
      const read = overlapPart(part);
      if (read?.kind !== 'data') return true;
      const namespace = namespaces[read.index];
      return namespace !== undefined && !UNHELD_NAMESPACES.has(namespace);
    });
    return {
      revision,
      base,
      theirs: theirs.payload,
      ours: this.#payload(),
      parts,
      by: theirs.authorId,
      gone: goneMode,
    };
  }

  async #parentOf(revision: RevisionId): Promise<RevisionId | null> {
    try {
      const opened = await this.#ports.openDraft(revision);
      this.#basedOn.set(revision, opened.basedOn);
      return opened.basedOn;
    } catch {
      return null;
    }
  }

  /** The merge Review shows for an opened note: only the overlaps its parts name. */
  reviewMerge(opened: OpenedNote): Merge {
    return reviewMerge(opened.base, opened.ours, opened.theirs, opened.parts, {
      gone: opened.gone,
    });
  }

  /**
   * Put Review's choices in, as the person's own change to those parts of
   * the document as it is now, never a whole merged payload, and take the
   * note out (ADR 0015 decision 8). False when the choices no longer fit
   * the page as it is, as when others changed those parts meanwhile.
   */
  applyReview(
    opened: OpenedNote,
    chosen: Merge,
    choices: Readonly<Record<string, Choice>>,
  ): boolean {
    if (!this.#keyed() || !this.#notes.has(opened.revision)) return false;
    const page = this.#payload();
    // The page as Review opened it: the choices as made, the blocks they made not fit included.
    if (samePayload(page, opened.ours)) {
      const target = reviewTarget(chosen, choices);
      if (!target) return false;
      return this.#putReview(opened.revision, target);
    }
    const { merge: now, choices: carried } = carryInto(
      chosen,
      choices,
      reviewMerge(opened.base, page, opened.theirs, opened.parts, { gone: opened.gone }),
    );
    // A choice of theirs at a part someone changed meanwhile is asked again, never dropped.
    const changing = (picked: Readonly<Record<string, Choice>>) =>
      Object.values(picked).filter((choice) => choice !== 'yours').length;
    const asked = chosen.overlaps.filter((overlap) => {
      const choice = choices[overlap.id];
      return choice !== undefined && choice !== 'yours';
    }).length;
    if (changing(carried) < asked) return false;
    const target = reviewTarget(now, carried);
    if (!target) return false;
    return this.#putReview(opened.revision, target);
  }

  // Review's choices into the document, as the person's change to those parts, and the note out.
  #putReview(revision: RevisionId, target: ReviewTarget): boolean {
    const { extensions = {}, ...texts } = target;
    this.change(
      {
        texts,
        entries: [
          ...Object.entries(extensions).map(([namespace, value]) => ({
            root: 'extensions' as const,
            key: namespace,
            value: value === null ? null : JSON.stringify(value),
          })),
          { root: 'overlaps', key: revision, value: null },
        ],
      },
      { byLines: true },
    );
    return true;
  }

  /** Dismiss a note: theirs in those parts is dropped for good. */
  dismissNote(revision: RevisionId): void {
    if (!this.#notes.has(revision)) return;
    this.change({ entries: [{ root: 'overlaps', key: revision, value: null }] });
  }

  // ---- Saving ----

  #changed(): void {
    this.#changedAt = Date.now();
    this.#unsavedSince ??= this.#changedAt;
    try {
      // As a save checks it: without the link table it works out.
      checkPayloadSize(withoutLinkTable(this.#payload()));
      this.#tooLarge = null;
    } catch (error) {
      // A value that doesn't fit the page: the change that placed it stops
      // the session (`apply`'s misplaced structs), never this listener.
      if (error instanceof PageTooLarge) this.#tooLarge = error.message;
      else if (!(error instanceof CryptoError)) throw error;
    }
    this.#scheduleSave();
    if (this.#checkTimer === null) {
      this.#checkTimer = setTimeout(() => {
        this.#checkTimer = null;
        this.#compare();
        void this.#learnHead();
      }, SEND_MS);
    }
    this.#update();
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    if (this.#unsavedSince === null || this.#status.state.kind !== 'live') return;
    const now = Date.now();
    const due = Math.max(
      this.#retryAt,
      Math.min(this.#changedAt + DEBOUNCE_MS, this.#unsavedSince + MAX_WAIT_MS),
    );
    this.#saveTimer = setTimeout(
      () => {
        this.#saveTimer = null;
        void this.#save({ force: false });
      },
      Math.max(0, due - now),
    );
  }

  /** Who saves (section 5.10, **Saving**): the first listed present join that's visible and not failing, else the first not failing. */
  #saver(): JoinRef | null {
    const candidates = [...this.#present]
      .filter(([join, present]) => present && this.#verified.has(join) && !this.#further.has(join))
      .map(([join]) => join)
      .sort((a, b) => (this.#order.get(a) ?? Infinity) - (this.#order.get(b) ?? Infinity));
    const me = key(this.#me);
    const read = (join: string) =>
      join === me
        ? { visible: this.#ports.visible(), saveFailing: this.#saveFailing }
        : (this.#presence.get(join) ?? { visible: false, saveFailing: null });
    const pick =
      candidates.find((join) => read(join).visible && !read(join).saveFailing) ??
      candidates.find((join) => !read(join).saveFailing);
    if (!pick) return null;
    const [senderId, joinId] = pick.split(' ') as [IdentityId, JoinId];
    return { senderId, joinId };
  }

  /**
   * Save the shared document as a draft of the session, if this app is the
   * saver, or once changes waited 20 s, or when `force`d: on the head, a
   * session draft the document holds; with `wikistow.live`; then a Saved
   * notice after everything it holds is sent. Whether it saved.
   */
  #save({ force }: { force: boolean }): Promise<boolean> {
    if (this.#saving) return this.#saving.then(() => (force ? this.#save({ force }) : false));
    const run = this.#saveOnce(force).finally(() => {
      this.#saving = null;
    });
    this.#saving = run;
    return run;
  }

  async #saveOnce(force: boolean): Promise<boolean> {
    if (this.#status.state.kind !== 'live' || this.#stopSending || this.#tooLarge) return false;
    const saver = this.#saver();
    const mine = saver !== null && key(saver) === key(this.#me);
    const waited = this.#unsavedSince !== null && Date.now() - this.#unsavedSince >= TAKE_OVER_MS;
    if (!force && !mine && !waited) {
      // Someone else saves; look again in case they don't.
      if (this.#unsavedSince !== null) {
        this.#retryAt = this.#unsavedSince + TAKE_OVER_MS;
        this.#scheduleSave();
      }
      return false;
    }
    const headId = this.#head;
    const head = headId ? this.#drafts.get(headId) : undefined;
    if (!headId || !head) {
      await this.#ensureHead();
      if (!this.#head || !this.#drafts.has(this.#head)) return false;
      return this.#saveOnce(force);
    }
    const state = this.document.state();
    if (!holdsState(state, head.state)) return false;
    if (holdsState(head.state, state)) {
      // Nothing the head doesn't hold.
      this.#unsavedSince = null;
      return true;
    }
    await this.flush();
    const stateBytes = this.document.stateBytes();
    const savedState = this.document.state();
    const covers = this.#covers;
    const revisionId = newId(RevisionId);
    const people = new Set<IdentityId>([...head.with, ...this.#typed]);
    let payload: PagePayload;
    try {
      payload = this.#payload(head.payload);
    } catch {
      return false;
    }
    const written = withLive(payload, {
      revision: revisionId,
      session: this.sessionId,
      state: stateBytes,
      with: [...people],
    });
    const choices = this.#linkChoices();
    try {
      const result = await this.#ports.saveDraft({
        basedOn: headId,
        revisionId,
        payload: written,
        linkChoices: choices,
      });
      this.#drafts.set(result.revisionId, {
        ours: true,
        revisionId: result.revisionId,
        payload: result.payload,
        state: savedState,
        compared: samePayload(payload, result.payload),
        with: [...people],
        openedAt: Date.now(),
      });
      if (this.#head === headId) this.#head = result.revisionId;
      if (this.#drafts.get(result.revisionId)?.compared) this.#checked = result.revisionId;
      this.#seenOwn(result.revisionId, headId);
      this.#saveFailing = null;
      this.#retryAt = 0;
      this.#unsavedSince = holdsState(savedState, this.document.state()) ? null : this.#changedAt;
      this.#queueSaved(result.revisionId, stateBytes, covers);
      this.#presenceDirty = true;
      void this.#maybeSnapshot(result.revisionId, savedState, covers);
      void this.#renameLinks(result.revisionId);
      this.#scheduleSave();
      this.#update();
      return true;
    } catch (error) {
      const grown =
        (error instanceof PageTooLarge && error.part === 'payload' && this.#tooLarge === null) ||
        (error instanceof ApiError && error.code === 'payload-too-large');
      if (grown) {
        // The page fits without `wikistow.live`, which takes it past the
        // limit: the session starts again, small, and the page saves as it
        // is (section 5.10, **Saving**).
        this.#stop('the live session grew too large, so it starts again', null, true, true);
        return false;
      }
      if (error instanceof PageTooLarge) {
        this.#tooLarge = error.message;
      } else if (error instanceof ApiError && error.code === 'stale-head') {
        // Someone saved first: the stream names the new head.
        const detail = error.detail as { draftHead?: unknown } | undefined;
        const parsed = RevisionId.safeParse(detail?.draftHead);
        if (parsed.success) this.#setHead(parsed.data);
        this.#retryAt = Date.now() + DEBOUNCE_MS;
      } else {
        this.#saveFailing = failingCode(error);
        this.#presenceDirty = true;
        this.#retryAt = Date.now() + 2 * DEBOUNCE_MS;
        this.#schedule();
      }
      this.#scheduleSave();
      this.#update();
      return false;
    }
  }

  #renamedAt = 0;

  /**
   * Rename the links of the draft just saved to their pages' current
   * titles, as any draft save does, at most every 30 s (section 5.10, **The
   * document**): only the saver renames, in a save's own join, so its saves
   * never differ from what everyone's document holds; and only while the
   * document has exactly that draft's state, so the change is of the text
   * everyone has, and typing meanwhile stays where it goes.
   */
  #renameLinks(saved: RevisionId): Promise<void> {
    return this.#tracked(this.#renameOnce(saved));
  }

  async #renameOnce(saved: RevisionId): Promise<void> {
    const ports = this.#ports;
    if (!ports.renamed || Date.now() - this.#renamedAt < 30_000 || this.#leaving) return;
    // Only the saver renames (section 5.10, **The document**).
    const saver = this.#saver();
    if (!saver || key(saver) !== key(this.#me)) return;
    this.#renamedAt = Date.now();
    const draft = this.#drafts.get(saved);
    if (!draft) return;
    let markdown: string | null;
    try {
      markdown = await ports.renamed(draft.payload, saved);
    } catch {
      return;
    }
    if (markdown === null) return;
    // The Saved notice of that save goes first.
    await this.flush();
    if (this.#head !== saved || !this.#keyed() || this.#leaving) return;
    if (this.#pending.length > 0 || this.#queue.length > 0 || this.#placing) return;
    if (!sameState(this.document.state(), draft.state)) return;
    const { frontmatter, body } = splitFrontmatter(markdown);
    const now = this.document.content();
    const was = splitFrontmatter(draft.payload.markdown);
    // The document's parts as the draft splits them: only a change within each.
    if ((was.frontmatter ?? '') !== now.frontmatter || was.body !== now.body) return;
    await this.commitOwn({ texts: { frontmatter: frontmatter ?? '', body } });
  }

  // The payload a save writes from the document, with the head's link table.
  #payload(base: PagePayload | null = this.headPayload, document = this.document): PagePayload {
    const payload = document.payload(base);
    const table = base?.extensions[LINKS_NAMESPACE];
    return table === undefined
      ? payload
      : { ...payload, extensions: { ...payload.extensions, [LINKS_NAMESPACE]: table } };
  }

  // The choices between pages of one title the session made, which a save's link table keeps.
  #linkChoices(document: LiveDocument = this.document): Map<string, PageId> {
    const choices = new Map<string, PageId>();
    for (const [linkKey, text] of document.map('links').entries()) {
      try {
        choices.set(linkKey, JSON.parse(text) as PageId);
      } catch {
        // A value the document checked as it was placed.
      }
    }
    return choices;
  }

  #queueSaved(revisionId: RevisionId, state: Uint8Array, covers: number): void {
    if (!this.#keyed()) return;
    const message = this.#seal({
      kind: 'saved',
      joinId: this.#me.joinId,
      seq: this.#seq,
      clock: this.#clock,
      content: stateContent(revisionId, state),
    });
    this.#clocks.set(this.#seq, this.#clock);
    this.#seq++;
    this.#queue.push({ message, covers });
    this.#savedCovers = Math.max(this.#savedCovers, covers);
    this.#schedule();
  }

  // The most any Saved notice of this app's has covered, and the latest
  // update taken, by position: a Saved notice is due only for updates after it.
  #savedCovers = 0;
  #lastUpdate = 0;
  #trailTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tell the server what is saved once it is (section 5.10, **Ending**): when
   * the head is a draft this app saved and compared, the document has
   * exactly its state, and stored messages after the last Saved notice it
   * sent are all in the document, a Saved notice naming the head covers
   * them. Otherwise a session nothing more happens in would look unsaved,
   * and be kept for the draft retention.
   */
  #trail(): void {
    if (!this.#keyed() || this.#lastUpdate <= this.#savedCovers) return;
    if (this.#covers < this.#lastUpdate) return;
    if (this.#pending.length > 0 || this.#queue.length > 0 || this.#sending || this.#placing)
      return;
    const head = this.#head ? this.#drafts.get(this.#head) : undefined;
    if (!head?.ours || !head.compared) return;
    try {
      if (!sameState(this.document.state(), head.state)) return;
    } catch {
      return;
    }
    this.#queueSaved(head.revisionId, this.document.stateBytes(), this.#covers);
  }

  #trailSoon(): void {
    if (this.#trailTimer || this.#lastUpdate <= this.#savedCovers) return;
    this.#trailTimer = setTimeout(() => {
      this.#trailTimer = null;
      this.#trail();
    }, DEBOUNCE_MS);
  }

  /**
   * Post a snapshot once the changes since the last pass both 256 KB and the
   * last one's size (ADR 0015 decision 6), from a further join that sends
   * nothing else, as of the save just made, while the document still has
   * exactly its state and everything in it is sent.
   */
  async #maybeSnapshot(revisionId: RevisionId, state: LiveState, covers: number): Promise<void> {
    if (this.#bytesSinceSnapshot < Math.max(SNAPSHOT_BYTES, this.#snapshotBytes)) return;
    await this.flush();
    if (this.#pending.length > 0 || this.#queue.length > 0 || this.document.pending) return;
    if (!sameState(this.document.state(), state)) return;
    const update = Y.encodeStateAsUpdate(this.document.doc);
    const further = newId(JoinId);
    try {
      await this.#sendAgain({
        joinId: further,
        parent: this.#me.joinId,
        messages: [
          {
            message: this.#seal({
              kind: 'update',
              joinId: further,
              seq: 1,
              clock: 0,
              content: new Uint8Array([0, 0]),
            }),
          },
        ],
      });
      // Sealed only while the key is still this app's to seal with.
      const message = this.#seal({
        kind: 'snapshot',
        joinId: further,
        seq: 2,
        clock: 0,
        content: stateContent(revisionId, update),
      });
      await this.#transport.snapshot({
        joinId: further,
        parent: this.#me.joinId,
        message,
        covers,
        revisionId,
      });
      void this.#transport.leave(further).catch(() => {});
      this.#snapshotBytes = message.sealed.ciphertext.length;
      this.#bytesSinceSnapshot = 0;
    } catch {
      // The next save tries again, from a join of its own.
      void this.#transport.leave(further).catch(() => {});
    }
  }

  // ---- Sending ----

  #own(update: Uint8Array): void {
    if (this.#stopSending) return;
    this.#pending.push(update);
    // Yjs tells of the update after the transaction's other listeners: what
    // shows as saved is worked out again now it is pending.
    this.#update();
    try {
      for (const [client, ranges] of decodeUpdate(update).deletes) {
        const list = this.#ownDeletes.get(client) ?? [];
        list.push(...ranges);
        this.#ownDeletes.set(client, list);
      }
    } catch {
      // Yjs's own output decodes; one that doesn't is refused when sealed.
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#sendTimer || this.#stopSending || this.#status.state.kind !== 'live') return;
    if (!this.#joined) return;
    const wait = Math.max(0, this.#lastSentAt + SEND_MS - Date.now());
    this.#sendTimer = setTimeout(() => {
      this.#sendTimer = null;
      void this.#send();
    }, wait);
  }

  /** Seal what's pending and send one request, the join's only one in flight. */
  #send(): Promise<void> {
    if (this.#sending) return this.#sending;
    if (this.#stopSending || this.#status.state.kind !== 'live' || !this.#joined) {
      return Promise.resolve();
    }
    if (this.#placing) {
      this.#schedule();
      return Promise.resolve();
    }
    const run = this.#sendOnce().finally(() => {
      this.#sending = null;
      if (this.#pending.length > 0 || this.#queue.length > 0 || this.#presenceDirty)
        this.#schedule();
    });
    this.#sending = run;
    return run;
  }

  async #sendOnce(): Promise<void> {
    // Nothing goes out once access to the page may have changed (section 5.10).
    if (!this.#keyed() || !this.#accessHolds()) return;
    if (this.#pending.length > 0) {
      const merged = Y.mergeUpdates(this.#pending);
      this.#pending = [];
      const clock = Y.getState(this.document.doc.store, this.#clientId);
      let message: LiveMessage;
      try {
        message = this.#seal({
          kind: 'update',
          joinId: this.#me.joinId,
          seq: this.#seq,
          clock,
          content: merged,
        });
      } catch (error) {
        if (error instanceof CryptoError) {
          // Too large for one message: it can't go into the session.
          return this.#stop('a change is too large to send', null, false);
        }
        throw error;
      }
      this.#clock = clock;
      this.#clocks.set(this.#seq, clock);
      this.#ownLog.push({ seq: this.#seq, update: merged });
      this.#seq++;
      this.#queue.push({ message });
      this.#bytesSinceSnapshot += message.sealed.ciphertext.length;
    }
    // Within the request limit: at most 32 messages, and about 700 KB of them.
    let size = 0;
    let count = 0;
    for (const item of this.#queue) {
      size += item.message.sealed.ciphertext.length + 256;
      if (count > 0 && (count >= 32 || size > 700_000)) break;
      count++;
    }
    const batch = this.#queue.slice(0, count);
    const messages: Outgoing[] = [...batch];
    // A presence carries the `seq` and `clock` of the last stored message before it.
    const last = batch.at(-1)?.message.seq ?? this.#sentSeq;
    const presence = this.#presenceDirty || Date.now() - this.#presenceAt >= PRESENCE_MS;
    if (presence) {
      messages.push({
        message: this.#seal({
          kind: 'presence',
          joinId: this.#me.joinId,
          seq: last,
          clock: this.#clocks.get(last) ?? 0,
          content: presenceContent(this.#presenceNow()),
        }),
      });
    }
    // A fold grant asked for, with whatever else goes (section 5.10, **Saving**).
    let ask = this.#foldAsk;
    this.#foldAsk = null;
    if (messages.length === 0 && !ask) return;
    this.#lastSentAt = Date.now();
    for (let tries = 0; ; tries++) {
      if (this.#stopSending || this.#abort.signal.aborted) return ask?.answer(null);
      try {
        const { positions, grant } = await this.#transport.send({
          joinId: this.#me.joinId,
          messages,
          ...(ask && { fold: ask.revision }),
        });
        for (const position of positions) {
          if (position !== null) this.#placed = Math.max(this.#placed, position);
        }
        if (grant) this.#grant(grant);
        ask?.answer(grant ?? null);
        ask = null;
        break;
      } catch (error) {
        if (ask && error instanceof ApiError && error.code === 'stale-head') {
          // The head moved on: no grant, and the rest goes without asking.
          ask.answer(null);
          ask = null;
          if (messages.length === 0) return;
          continue;
        }
        if (error instanceof ApiError && (outcomeUnknown(error) || error.code === 'rate-limited')) {
          // The same request again, unchanged: a repeat is taken as stored.
          if (tries >= 20) {
            ask?.answer(null);
            return this.#stop('the session stopped answering', null, true);
          }
          await sleep(Math.min(250 * 2 ** tries, 2_000), this.#abort.signal);
          continue;
        }
        if (error instanceof ApiError && error.code === 'forbidden') {
          // The session ended: go on outside it, whether or not its stream says so.
          ask?.answer(null);
          return this.#stop('the live session ended', null, true);
        }
        ask?.answer(null);
        const code = error instanceof ApiError ? error.code : 'unknown';
        return this.#stop(`the session refused a change (${code})`, null, true);
      }
    }
    this.#queue = this.#queue.slice(batch.length);
    this.#sentSeq = last;
    if (presence) {
      this.#presenceDirty = false;
      this.#presenceAt = Date.now();
    }
  }

  #sentSeq = 0;
  // The highest position the server gave a stored message of this app's main join.
  #placed = 0;
  /** Each stored message's `clock`, by `seq`: a notice's is the update's before it. */
  readonly #clocks = new Map<number, number>();

  #presenceNow(): LivePresence {
    const cursor = this.#cursor;
    return {
      format: { major: 1, minor: 0 },
      editor: this.#ports.editor(),
      visible: this.#ports.visible(),
      publishing: false,
      saveFailing: this.#saveFailing,
      cursor: cursor && { anchor: toBase64Url(cursor.anchor), head: toBase64Url(cursor.head) },
    };
  }

  // ---- Status ----

  /**
   * Leave the session, going on outside it. `end` ends it for everyone, as
   * an app that can't take part does, so the next start makes a fresh one;
   * otherwise only this app leaves (section 5.10, **Saving**).
   */
  #stop(why: string, saveOver: RevisionId | null, rejoin: boolean, end = false): void {
    // Before it is made, as from a grant served with the session: once it is.
    if (!this.#status) {
      this.#stopLater ??= { why, saveOver, rejoin, end };
      return;
    }
    if (this.#status.state.kind !== 'live') return;
    end ||= this.#joining;
    this.#stopSending = true;
    const state: ParticipantState = { kind: 'stopped', why, saveOver, rejoin };
    this.#close(state);
    if (end) void this.#transport.end().catch(() => {});
  }

  #ownState(): LiveState {
    const clock = Y.getState(this.document.doc.store, this.#clientId);
    return {
      vector: clock > 0 ? new Map([[this.#clientId, clock]]) : new Map(),
      deletes: this.#ownDeletes,
    };
  }

  #computeStatus(state: ParticipantState): ParticipantStatus {
    const head = this.#head ? this.#drafts.get(this.#head) : undefined;
    let saved = false;
    if (head?.compared && this.#pending.length === 0) {
      try {
        saved =
          holdsState(head.state, this.#ownState()) && holdsState(this.document.state(), head.state);
      } catch {
        saved = false;
      }
    }
    const saver = this.#saver();
    const me = key(this.#me);
    const failing = [...this.#presence]
      .filter(([join, read]) => read.saveFailing && this.#present.get(join))
      .map(([join, read]) => ({
        id: join.split(' ')[0] as IdentityId,
        reason: read.saveFailing ?? '',
      }))[0];
    const people = new Map<IdentityId, LivePerson>();
    for (const [join, present] of this.#present) {
      if (!present || join === me || !this.#verified.has(join) || this.#further.has(join)) continue;
      const [id, joinId] = join.split(' ') as [IdentityId, JoinId];
      if (id === this.#me.senderId) continue;
      const shown = this.#presence.get(join)?.shown ?? null;
      const person = people.get(id) ?? { id, joins: [] };
      person.joins.push({ joinId, editor: shown?.editor ?? null, cursor: shown?.cursor ?? null });
      people.set(id, person);
    }
    return {
      state,
      saved,
      head: this.#head,
      checked: this.#checked,
      saver: saver === null ? null : key(saver) === me ? 'me' : saver.senderId,
      failing:
        failing ??
        (this.#saveFailing ? { id: this.#me.senderId, reason: this.#saveFailing } : null),
      tooLarge: this.#tooLarge,
      people: [...people.values()],
      provisional: this.#provisional,
      notes: [...this.#notes.values()].map((note) => ({ ...note, parts: [...note.parts] })),
      connected: this.#connected,
    };
  }

  #update(state: ParticipantState = this.#status.state): void {
    this.#status = this.#computeStatus(state);
    for (const listener of this.#listeners) listener();
  }
}

/** A change of the document's text parts and maps: each text by its smallest change, each entry set or, as null, deleted. */
export type DocumentChange = {
  texts?: Partial<Record<TextRoot, string>>;
  entries?: readonly { root: MapRoot; key: string; value: string | null }[];
};

function applyChange(
  document: LiveDocument,
  { texts = {}, entries = [] }: DocumentChange,
  /** Each run of lines that differs, not one span, as for a change of several far-apart places. */
  byLines = false,
): void {
  for (const [name, text] of Object.entries(texts) as [TextRoot, string][]) {
    if (byLines) changeTextByLines(document.text(name), text);
    else changeText(document.text(name), text);
  }
  for (const { root, key: entry, value } of entries) {
    const map = document.map(root);
    if (value === null) {
      if (map.has(entry)) map.delete(entry);
    } else if (map.get(entry) !== value) {
      map.set(entry, value.toWellFormed());
    }
  }
}

// The state of a fresh document once the first snapshot is applied (section 5.10, **States**).
function stateOfSnapshot(
  first: LiveMessage,
  binding: LiveBinding,
  ctx: ClientContext,
  joins: LiveJoins,
): LiveState | null {
  try {
    const opened = openLiveMessage({
      binding,
      trust: ctx.trust,
      listed: (header) => joins.listed(header),
      message: first,
    });
    const read = readSnapshot(opened.content);
    if (read.kind !== 'current') return null;
    const document = new LiveDocument(0x1fffffffffffff);
    document.apply(read.state, 'snapshot');
    return document.state();
  } catch {
    return null;
  }
}

// Who a draft's `wikistow.live` says edited it, carried by the next save.
function withOf(payload: PagePayload): IdentityId[] {
  const parsed = LiveExtension.safeParse(payload.extensions[LIVE_NAMESPACE]);
  return parsed.success ? parsed.data.with.filter((id) => IdentityId.safeParse(id).success) : [];
}

// A save's failure as a presence's `saveFailing`: 1 to 64 of `a`–`z` and `-`.
function failingCode(error: unknown): string {
  if (error instanceof ApiError) {
    if (outcomeUnknown(error)) return 'network';
    const code = error.code
      .toLowerCase()
      .replace(/[^a-z-]/g, '')
      .slice(0, 64);
    return code || 'unknown';
  }
  return 'unknown';
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// A note's parts, from its entry's JSON text, those of a form this app reads; null when none.
function noteParts(text: string, revision: RevisionId): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = OverlapEntry.safeParse(value);
  if (!entry.success || entry.data.revision !== revision) return null;
  const parts = [...new Set(entry.data.parts.filter((part) => overlapPart(part) !== null))];
  return parts.length > 0 ? parts : null;
}

const sameParts = (a: readonly string[], b: readonly string[]) => {
  const known = new Set(b.filter((part) => overlapPart(part) !== null));
  return a.length === known.size && a.every((part) => known.has(part));
};

// A state with an update's structs and deletions added, as a fold placed without a save holds.
function plusUpdate(state: LiveState, update: DecodedUpdate): LiveState {
  const vector = new Map(state.vector);
  for (const structs of update.structs) {
    vector.set(structs.client, Math.max(vector.get(structs.client) ?? 0, structs.end));
  }
  const deletes = new Map([...state.deletes].map(([client, ranges]) => [client, [...ranges]]));
  for (const [client, ranges] of update.deletes) {
    deletes.set(client, [...(deletes.get(client) ?? []), ...ranges]);
  }
  return { vector, deletes };
}

// JSON values as equal, objects' members in any order.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((name) => Object.hasOwn(y, name) && sameJson(x[name], y[name]))
  );
}

/**
 * Write a fold's target into `document`, changing only what differs: each
 * text by its smallest change, each attachment and namespace whose value
 * differs set, and those the target lacks taken out.
 */
function writeTarget(document: LiveDocument, target: FoldTarget): void {
  changeText(document.text('title'), target.title);
  changeTextByLines(document.text('frontmatter'), target.frontmatter);
  changeTextByLines(document.text('body'), target.body);
  const sync = (root: 'attachments' | 'extensions', wanted: Map<string, unknown>) => {
    const map = document.map(root);
    for (const name of [...map.keys()]) if (!wanted.has(name)) map.delete(name);
    for (const [name, value] of wanted) {
      const held = map.get(name);
      let same = false;
      try {
        same = held !== undefined && sameJson(JSON.parse(held), value);
      } catch {
        same = false;
      }
      if (!same) map.set(name, JSON.stringify(value).toWellFormed());
    }
  };
  sync('attachments', new Map(target.attachments.map((ref) => [ref.id, ref])));
  sync(
    'extensions',
    new Map(
      Object.entries(target.extensions).filter(([namespace]) => !UNHELD_NAMESPACES.has(namespace)),
    ),
  );
}

// A draft whose own `wikistow.live` names another session (section 5.10, **Saving**).
function ofAnotherSession(draft: OpenedDraft, sessionId: string): boolean {
  // A person's: an agent never saves a session's drafts.
  if (isAgentId(draft.authorId)) return false;
  const live = draftLive(draft.payload, draft.revisionId);
  return live.kind === 'live' && live.extension.session !== sessionId;
}

// Gone joins' clients whose changes a fold put in, by session: kept across
// this app's joins of a session, so joining again never folds them twice.
const foldedGone = new Map<string, Map<number, GoneRange>>();

/** The clocks of a gone join's client a fold put in, from what the folding app held to what the draft claimed. */
type GoneRange = { from: number; to: number };
// Sessions this app left once because it couldn't catch up with the others.
const cantCatchUp = new Set<string>();
