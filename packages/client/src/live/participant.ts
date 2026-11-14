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
import { LINKS_NAMESPACE } from '../link-table.ts';
import type { ClientContext } from '../operations/session.ts';
import { checkPayloadSize, PageTooLarge, type PagePayload } from '../payload.ts';
import { sameRegion, type Region } from '../regions.ts';
import {
  decodeUpdate,
  holdsState,
  sameState,
  type DecodedUpdate,
  type LiveState,
  type MapRoot,
  type TextRoot,
} from './decode.ts';
import { LiveDocument, samePayload } from './document.ts';
import { sessionState, withLive } from './extension.ts';
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
import { changeText, textChange } from './text-change.ts';

/** A draft of the page, opened. */
export type OpenedDraft = {
  revisionId: RevisionId;
  payload: PagePayload;
  authorId: IdentityId;
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

  constructor(ports: ParticipantPorts, opening: Opening) {
    this.#ports = ports;
    this.#opened = opening.opened;
    this.#binding = liveBinding(opening.opened);
    this.#joins = opening.joins;
    this.document = opening.document;
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
    this.document.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN) this.#own(update);
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
  change(spec: DocumentChange): void {
    this.edit((document) => applyChange(document, spec));
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
    } catch {
      // Access that can't be read again can't be checked: stop, and join again later.
      this.#stopSending = true;
      return this.#stop('access to the page couldn’t be checked', null, true);
    }
    try {
      requireLiveAccess(this.#opened, access);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      this.#stopSending = true;
      this.#stop(error.message, null, true);
    }
  }

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
   * Make a change this app must save itself before anyone else sees it,
   * as a file it uploaded, which only its uploader may commit to a revision
   * (section 5.10, **Files**): in a copy of the document under a further
   * join of its own, saved as a draft of the session, and sent from that
   * join once the save has landed, with a Saved notice after it. Its main
   * join sends nothing built on it until it is placed. Whether it went in.
   */
  async commitOwn(change: ((document: LiveDocument) => void) | DocumentChange): Promise<boolean> {
    // Text given whole is made a change of the text as it is now, anchored
    // in it, so whatever others type meanwhile, around it, stays.
    const make = typeof change === 'function' ? change : this.#anchored(change);
    if (!this.#keyed()) return false;
    await this.flush();
    await this.#ensureHead();
    const headId = this.#head;
    const head = headId ? this.#drafts.get(headId) : undefined;
    if (!this.#keyed() || this.#pending.length > 0 || this.#queue.length > 0) return false;
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
      result = await this.#ports.saveDraft({
        basedOn: headId,
        revisionId,
        payload: withLive(payload, {
          revision: revisionId,
          session: this.sessionId,
          state: stateBytes,
          with: [...people],
        }),
        linkChoices: this.#linkChoices(copy),
      });
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
      const span = textChange(text.toJSON(), target.toWellFormed());
      if (!span) return [];
      const from = Y.createRelativePositionFromTypeIndex(text, span.from);
      // An insertion has one place, which typing there meanwhile goes before.
      const to =
        span.remove === 0
          ? from
          : Y.createRelativePositionFromTypeIndex(text, span.from + span.remove, -1);
      return [{ name, target, span, from, to }];
    });
    return (document) => {
      for (const { name, target, span, from, to } of spans) {
        const text = document.text(name);
        const start = Y.createAbsolutePositionFromRelativePosition(from, document.doc);
        const end = Y.createAbsolutePositionFromRelativePosition(to, document.doc);
        if (!start || !end || start.type !== text || end.type !== text || end.index < start.index) {
          // Where it was can't be found: the whole text, as given.
          changeText(text, target);
          continue;
        }
        if (end.index > start.index) text.delete(start.index, end.index - start.index);
        if (span.insert !== '') text.insert(start.index, span.insert);
      }
      applyChange(document, { entries });
    };
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
    ]) {
      if (timer) clearTimeout(timer);
    }
    if (this.#presenceTimer) clearInterval(this.#presenceTimer);
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
          this.#line(line);
          if (this.#status.state.kind !== 'live') return;
        }
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        if (error instanceof ApiError && !outcomeUnknown(error) && error.code !== 'rate-limited') {
          // The join went, a snapshot deleted what it missed, or the stream was refused.
          return this.#stop(`the session’s stream was refused (${error.code})`, null, true);
        }
      }
      if (this.#abort.signal.aborted || this.#status.state.kind !== 'live') return;
      brokeAt ??= Date.now();
      if (Date.now() - brokeAt > GRACE_MS) {
        return this.#stop('the connection to the session was lost', null, true);
      }
      await sleep(pause, this.#abort.signal);
      pause = Math.min(pause * 2, 4_000);
    }
  }

  #line(line: liveRoutes.StreamLine): void {
    if ('joins' in line) this.#listJoins(line.joins);
    else if ('message' in line) this.#receive(line.message);
    else if ('presence' in line) this.#receivePresence(line.presence);
    else if ('ended' in line) {
      this.#setHead(line.draftHead);
      return this.#ended(line.ended);
    }
    this.#setHead(line.draftHead);
    this.#update();
  }

  #listJoins(joins: readonly liveRoutes.Join[]): void {
    this.#joins.list(listedOf(joins));
    for (const join of joins) {
      const ref = { senderId: join.senderId, joinId: join.joinId };
      this.#order.set(key(ref), join.order);
      this.#present.set(key(ref), join.present);
      if (join.parent) this.#further.add(key(ref));
    }
    for (const held of this.#held) {
      if (held.reason === 'gap' && this.#present.get(key(held.opened)) === false) {
        // A gap from a join that went can't close.
        return this.#stop('a join went with messages missing', null, true);
      }
    }
    this.#scheduleSave();
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
    } else if (opened.kind === 'saved') {
      try {
        readSaved(opened.content);
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
    if (head === this.#head) return;
    this.#head = head;
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
      // A draft written outside the session: folding it in is step 7's.
      // Until then nobody in the session can save over it: the session ends.
      return this.#stop('someone saved this page from outside the live session', null, false, true);
    }
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
    const state = sessionState(draft.payload, draft.revisionId, this.sessionId);
    const signer = [...this.#verified].some((join) => join.startsWith(`${draft.authorId} `));
    const ours = state !== null && !isAgentId(draft.authorId) && sameKeys(draft, this.#opened);
    if (!ours || !state) {
      this.#outsiders.add(head);
      return;
    }
    if (!signer) {
      const since = (this.#unknownSigner ??= { head, at: Date.now() });
      if (since.head !== head) this.#unknownSigner = { head, at: Date.now() };
      else if (Date.now() - since.at > HOLD_MS) this.#outsiders.add(head);
      else if (!this.#checkTimer && this.#status.state.kind === 'live') {
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
    });
  }

  #unknownSigner: { head: RevisionId; at: number } | null = null;

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
    this.#update();
  }

  // ---- Saving ----

  #changed(): void {
    this.#changedAt = Date.now();
    this.#unsavedSince ??= this.#changedAt;
    try {
      checkPayloadSize(this.#payload());
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
      this.#saveFailing = null;
      this.#retryAt = 0;
      this.#unsavedSince = holdsState(savedState, this.document.state()) ? null : this.#changedAt;
      this.#queueSaved(result.revisionId, stateBytes, covers);
      this.#presenceDirty = true;
      void this.#maybeSnapshot(result.revisionId, savedState, covers);
      this.#scheduleSave();
      this.#update();
      return true;
    } catch (error) {
      if (error instanceof PageTooLarge) {
        this.#tooLarge = error.message;
      } else if (error instanceof ApiError && error.code === 'payload-too-large') {
        // Its text fits, so the session's own state takes it past the
        // limit: the session starts again, small, and the page saves as it
        // is (section 5.10, **Saving**).
        this.#stop('the live session grew too large, so it starts again', null, true, true);
        return false;
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
    if (messages.length === 0) return;
    this.#lastSentAt = Date.now();
    for (let tries = 0; ; tries++) {
      if (this.#stopSending || this.#abort.signal.aborted) return;
      try {
        const { positions } = await this.#transport.send({ joinId: this.#me.joinId, messages });
        for (const position of positions) {
          if (position !== null) this.#placed = Math.max(this.#placed, position);
        }
        break;
      } catch (error) {
        if (error instanceof ApiError && (outcomeUnknown(error) || error.code === 'rate-limited')) {
          // The same request again, unchanged: a repeat is taken as stored.
          if (tries >= 20) return this.#stop('the session stopped answering', null, true);
          await sleep(Math.min(250 * 2 ** tries, 2_000), this.#abort.signal);
          continue;
        }
        if (error instanceof ApiError && error.code === 'forbidden') {
          // The session ended: go on outside it, whether or not its stream says so.
          return this.#stop('the live session ended', null, true);
        }
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

function applyChange(document: LiveDocument, { texts = {}, entries = [] }: DocumentChange): void {
  for (const [name, text] of Object.entries(texts) as [TextRoot, string][]) {
    changeText(document.text(name), text);
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
