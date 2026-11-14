// Catching up from an ended live session (ADR 0015 decision 12, protocol
// section 5.10, **Ending**): a session that ended with changes no draft
// holds, as when the saver's tab closed within a second of typing and then
// access to the page changed, is kept read-only for the next editor. Their
// app opens it with every check a join makes, builds its document, checks
// it against the latest Saved notice's draft before anything is saved
// from it, takes the server's grant so nobody else puts it in too, saves
// what the head doesn't hold, and sends a Saved notice, so the server
// deletes it.
import { JoinId, RevisionId, liveRoutes, type PageId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { isAgentId } from '../identity.ts';
import { newId } from '../ids.ts';
import { LINKS_NAMESPACE } from '../link-table.ts';
import { mergePayloads, resolve } from '../merge/payload.ts';
import type { PagePayload } from '../payload.ts';
import { sameRegion } from '../regions.ts';
import { decodeUpdate, holdsState, sameState, type LiveState } from './decode.ts';
import { LiveDocument, samePayload } from './document.ts';
import { draftLive, sessionState, withoutLive } from './extension.ts';
import { heldPayload } from './fold.ts';
import { LiveJoins, type ListedJoin } from './joins.ts';
import {
  liveClientId,
  openLiveMessage,
  readSaved,
  readSnapshot,
  sealLiveMessage,
  stateContent,
  type OpenedLiveMessage,
} from './messages.ts';
import { liveTransport, openServedSession } from './operations.ts';
import type { OpenedDraft, ParticipantPorts } from './participant.ts';
import { liveBinding, type OpenedLiveSession } from './session.ts';
import { openSnapshot } from './snapshot.ts';

/** What catching up from an ended session came to. */
export type CaughtUp =
  /** It saved what the head didn't hold, as `revisionId` on `basedOn`; `overlapped` parts kept the head's text. */
  | {
      kind: 'saved';
      revisionId: RevisionId;
      basedOn: RevisionId;
      payload: PagePayload;
      overlapped: number;
    }
  /** The head held all of it already: nothing was saved, and the session can go. */
  | { kind: 'held' }
  /** Another editor's app is catching up from it now, or did: nothing to do. */
  | { kind: 'elsewhere' }
  /**
   * It can't catch up from it, and says why; the session is left for the
   * draft retention. `lasting` when the session itself fails its checks,
   * so trying again this run finds the same; otherwise it may pass.
   */
  | { kind: 'cant'; why: string; lasting: boolean }
  /** This app's keys no longer count for it: its unsaved changes can't be recovered. */
  | { kind: 'lost' };

/** The joins a session's served list names, as `LiveJoins.list` takes them. */
export const listedOf = (joins: readonly liveRoutes.Join[]): ListedJoin[] =>
  joins.map((join) => ({
    senderId: join.senderId,
    senderKeyVersion: join.senderKeyVersion,
    joinId: join.joinId,
    // A further join's parent is always the same person's.
    parent: join.parent ? { senderId: join.senderId, joinId: join.parent } : null,
    present: join.present,
  }));

/** A draft under the session record's key material: its region, and in a share its key version. */
export const sameKeys = (draft: OpenedDraft, opened: OpenedLiveSession) =>
  sameRegion(draft.region, opened.region) &&
  (opened.region.kind === 'owner' || draft.keyVersion === opened.keyVersion);

/** A draft whose own `wikistow.live` names another session than `sessionId`. */
export function ofAnotherSession(draft: OpenedDraft, sessionId: string): boolean {
  // A person's: an agent never saves a session's drafts.
  if (isAgentId(draft.authorId)) return false;
  const live = draftLive(draft.payload, draft.revisionId);
  return live.kind === 'live' && live.extension.session !== sessionId;
}

// How far back the head's signed chain is walked for a draft of the session.
const CHAIN_STEPS = 256;

/**
 * Catch up from `served`, an ended session kept with unsaved changes, the
 * draft head being `head` (section 5.10, **Ending**). Never throws for
 * what the session or the server sent: a session this app can't catch up
 * from is `cant`, with why.
 */
export async function catchUpEnded(
  ports: ParticipantPorts,
  served: liveRoutes.ServedSession,
  head: RevisionId | null,
): Promise<CaughtUp> {
  const { ctx, page } = ports;
  if (ctx.agent || isAgentId(ctx.identity.public.id)) return { kind: 'elsewhere' };
  let opened: OpenedLiveSession;
  try {
    opened = openServedSession(ctx, served, page, await ports.access(false));
  } catch (error) {
    if (!(error instanceof CryptoError)) return passing(error);
    // Under keys that no longer count for writing, or of another region now.
    if (['key-version', 'region-mismatch', 'unaccepted-owner'].includes(error.code)) {
      return { kind: 'lost' };
    }
    return {
      kind: 'cant',
      why:
        error.code === 'unsupported-format'
          ? 'it is of a newer format: update the app'
          : `its record was refused: ${error.message}`,
      lasting: true,
    };
  }
  try {
    const built = await build(ports, served, opened);
    if (built.kind === 'cant') return built;
    return await putIn(ports, served, opened, built, head);
  } catch (error) {
    if (error instanceof CryptoError) return { kind: 'cant', why: error.message, lasting: true };
    return passing(error);
  } finally {
    opened.key.fill(0);
  }
}

// What the server answered, or a draft it didn't serve: it may pass.
function passing(error: unknown): CaughtUp {
  const why =
    error instanceof ApiError
      ? `the server answered ${error.code}`
      : error instanceof Error
        ? error.message
        : 'it failed';
  return { kind: 'cant', why, lasting: false };
}

const lasting = (why: string) => ({ kind: 'cant' as const, why, lasting: true });

/** The ended session's document, checked, and what it was checked against. */
type Built = {
  kind: 'built';
  document: LiveDocument;
  /** The latest draft of the session it was checked against, with its state as the session counts it. */
  latest: { revisionId: RevisionId; payload: PagePayload; state: LiveState };
  /** Whether it holds anything that draft doesn't. */
  unsaved: boolean;
  /** The draft the session started from, with the first snapshot's state. */
  start: { revisionId: RevisionId; payload: PagePayload; state: LiveState };
  /** People with a join in the session that a message was taken from. */
  signers: ReadonlySet<string>;
};

// Build the ended session's document as a newcomer would, from its latest
// snapshot and the messages after it, and check it, at the position the
// latest Saved notice covers, against the draft that notice names; with
// no notice, only a document built from the first snapshot alone counts.
async function build(
  ports: ParticipantPorts,
  served: liveRoutes.ServedSession,
  opened: OpenedLiveSession,
): Promise<Built | { kind: 'cant'; why: string; lasting: boolean }> {
  const { ctx, page } = ports;
  // What a fetch cut short leaves to the stream: past what an ended session's unsaved typing comes to.
  if (!served.complete) return lasting('it holds more than one fetch serves');
  const sessionId = opened.record.subjectId;
  const binding = liveBinding(opened);
  const joins = new LiveJoins({
    installationId: ctx.installationId,
    sessionId,
    starter: { senderId: opened.starter.senderId, joinId: opened.starter.joinId },
  });
  joins.list(listedOf(served.joins));
  const open = (message: liveRoutes.StoredMessage['message']) =>
    openLiveMessage({ binding, trust: ctx.trust, listed: (h) => joins.listed(h), message });
  // Its own client: one no join derives, and which never writes.
  const clientId = liveClientId({
    installationId: ctx.installationId,
    sessionId,
    senderId: ctx.identity.public.id,
    senderKeyVersion: ctx.identity.public.keyVersion,
    joinId: newId(JoinId),
  });
  const signers = new Set<string>([opened.starter.senderId]);
  const first = open(served.firstSnapshot.message);
  const firstRead = readSnapshot(first.content);
  if (firstRead.kind === 'newer-format') {
    return lasting('it is of a newer format: update the app');
  }
  const scratch = new LiveDocument(clientId);
  if (scratch.apply(firstRead.state, 'snapshot').length > 0 || scratch.pending) {
    return lasting('its first snapshot doesn’t fit the page');
  }
  const firstState = scratch.state();
  let document: LiveDocument;
  let covered: number;
  let built: { revisionId: RevisionId; payload: PagePayload; state: LiveState };
  let start: Built['start'] | null = null;
  if (served.snapshot) {
    const later = open(served.snapshot.message);
    const started = new Set<string>();
    for (const stored of served.latest) {
      const message = open(stored.message);
      joins.startFrom(message);
      started.add(`${message.senderId} ${message.joinId}`);
      signers.add(message.senderId);
    }
    if (!started.has(`${first.senderId} ${first.joinId}`)) joins.startFrom(first);
    const read = readSnapshot(later.content);
    if (read.kind === 'newer-format') {
      return lasting('it is of a newer format: update the app');
    }
    const draft = await ports.openDraft(read.revisionId);
    if (!sessionDraft(draft, opened, signers)) {
      return lasting('its snapshot names a draft from outside the session');
    }
    document = openSnapshot({
      message: later,
      session: opened,
      joins,
      revision: { ...draft, pageId: page.pageId },
      clientId,
    }).document;
    const verdict = joins.check(later, decodeUpdate(read.state));
    if (verdict.kind === 'take') joins.take(later);
    covered = served.snapshot.covers ?? served.firstSnapshot.position;
    built = { revisionId: draft.revisionId, payload: draft.payload, state: document.state() };
  } else {
    const draft = await ports.openDraft(opened.payload.revisionId);
    document = openSnapshot({
      message: first,
      session: opened,
      joins,
      revision: { ...draft, pageId: page.pageId },
      clientId,
    }).document;
    if (joins.check(first, decodeUpdate(firstRead.state)).kind !== 'take') {
      return lasting('its first snapshot isn’t its join’s first message');
    }
    joins.take(first);
    covered = served.firstSnapshot.position;
    built = { revisionId: draft.revisionId, payload: draft.payload, state: firstState };
    start = built;
  }

  // Every kept message, opened: its sender verified, as a join of the session's.
  const stored = [...served.latest, ...served.messages];
  const opens = new Map(stored.map((one) => [one, open(one.message)] as const));
  const senders = new Set<string>([...signers, ...[...opens.values()].map((m) => m.senderId)]);
  // The latest Saved notice that names a draft of the session, by position:
  // one naming a draft from outside folded in without a save, or none the
  // server serves, is passed over for an earlier one, as checked.
  let notice: { covers: number; draft: OpenedDraft; state: LiveState } | null = null;
  const notices = stored
    .filter((one) => one.message.kind === 'saved')
    .sort((a, b) => b.position - a.position);
  for (const one of notices) {
    const read = readSaved((opens.get(one) as OpenedLiveMessage).content);
    if (read.kind === 'newer-format') return lasting('it is of a newer format: update the app');
    const draft = await ports.openDraft(read.revisionId).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'not-found') return null;
      throw error;
    });
    const state = draft && sessionState(draft.payload, draft.revisionId, sessionId);
    if (!draft || !state || !sessionDraft(draft, opened, senders)) continue;
    notice = { covers: one.covers ?? 0, draft, state };
    break;
  }
  // With none, only a document built from the first snapshot alone is checked.
  if (!notice && served.snapshot) {
    return lasting('no Saved notice checks what its later snapshot holds');
  }
  const covers = notice ? notice.covers : covered;
  let latest: Built['latest'] | null = notice ? null : built;

  const check = () => {
    if (!notice) return;
    const { draft, state } = notice;
    const ok =
      sameState(document.state(), state) &&
      samePayload(document.payload(draft.payload), draft.payload);
    if (!ok) throw new CryptoError('binding-mismatch', 'it doesn’t check against its last save');
    latest = { revisionId: draft.revisionId, payload: draft.payload, state };
  };

  // A fold's change placed for a revision whose fold was placed already is never placed.
  const placedAt = new Map<string, number>();
  for (const grant of served.grants) {
    if (grant.position === null) continue;
    const first = placedAt.get(grant.subject);
    if (first === undefined || grant.position < first) placedAt.set(grant.subject, grant.position);
  }
  const secondFold = (position: number) =>
    served.grants.some(
      (grant) => grant.position === position && placedAt.get(grant.subject) !== position,
    );

  const messages = [...served.messages].sort((a, b) => a.position - b.position);
  let checked = covers <= covered;
  if (checked) check();
  type One = { stored: liveRoutes.StoredMessage; message: OpenedLiveMessage; decoded?: Decoded };
  let held: One[] = [];
  const take = (one: One) => {
    const { message } = one;
    one.decoded ??= decodedOf(message);
    const { decoded } = one;
    const verdict = joins.check(message, decoded ?? undefined);
    if (verdict.kind === 'repeat') return true;
    if (verdict.kind === 'hold') return false;
    if (verdict.kind !== 'take') {
      throw new CryptoError(
        'binding-mismatch',
        verdict.kind === 'refuse'
          ? `a message was refused: ${verdict.why}`
          : 'a message was sent twice',
      );
    }
    if (message.kind === 'update') {
      if (secondFold(one.stored.position)) {
        throw new CryptoError('binding-mismatch', 'a change from outside was folded in twice');
      }
      const misplaced = document.apply(message.content, 'remote');
      if (misplaced.length > 0) {
        throw new CryptoError(
          'binding-mismatch',
          `a change doesn’t fit the page: ${misplaced[0]?.why}`,
        );
      }
    }
    joins.take(message);
    signers.add(message.senderId);
    return true;
  };
  for (const stored of messages) {
    if (!checked && stored.position > covers) {
      if (held.length > 0) return lasting('messages it holds are missing');
      check();
      checked = true;
    }
    const message = opens.get(stored) as OpenedLiveMessage;
    if (!take({ stored, message })) {
      held.push({ stored, message });
      continue;
    }
    // What it held up may fit now.
    for (let moved = true; moved && held.length > 0;) {
      moved = false;
      const waiting = held;
      held = [];
      for (const next of waiting) {
        if (take(next)) moved = true;
        else held.push(next);
      }
    }
  }
  if (!checked) check();
  if (held.length > 0 || document.pending) {
    return lasting('messages it holds are missing');
  }
  const at = latest as Built['latest'] | null;
  if (!at) return lasting('it doesn’t check against its last save');
  // A draft of the session its notice's sender saved: that sender counts as one who signed in it.
  for (const message of opens.values()) signers.add(message.senderId);
  if (!start) {
    const draft = await ports.openDraft(opened.payload.revisionId);
    start = { revisionId: draft.revisionId, payload: draft.payload, state: firstState };
  }
  return {
    kind: 'built',
    document,
    latest: at,
    unsaved: !holdsState(at.state, document.state()),
    start,
    signers,
  };
}

// A draft of the session: its `wikistow.live` names it and the session, or
// it is the draft the session started from; signed by a person with a join
// in it that a message was taken from; under the record's key material.
function sessionDraft(
  draft: OpenedDraft,
  opened: OpenedLiveSession,
  signers: ReadonlySet<string>,
): boolean {
  if (isAgentId(draft.authorId) || !sameKeys(draft, opened)) return false;
  if (draft.revisionId === opened.payload.revisionId) return true;
  return (
    sessionState(draft.payload, draft.revisionId, opened.record.subjectId) !== null &&
    signers.has(draft.authorId)
  );
}

type Decoded = ReturnType<typeof decodeUpdate> | null;

// What a stored message changes, decoded once: an update's, a snapshot's
// state; none for a Saved notice, whose content must still read.
function decodedOf(message: OpenedLiveMessage): Decoded {
  if (message.kind === 'update') return decodeUpdate(message.content);
  if (message.kind === 'snapshot') {
    const read = readSnapshot(message.content);
    return read.kind === 'current' ? decodeUpdate(read.state) : { structs: [], deletes: new Map() };
  }
  readSaved(message.content);
  return null;
}

// Take the grant, save what the head doesn't hold, and send the Saved
// notice that lets the server delete the session.
async function putIn(
  ports: ParticipantPorts,
  served: liveRoutes.ServedSession,
  opened: OpenedLiveSession,
  built: Built,
  startHead: RevisionId | null,
): Promise<CaughtUp> {
  const { ctx } = ports;
  const sessionId = served.sessionId;
  const transport = liveTransport(ctx, sessionId, ports.live);
  const joinId = newId(JoinId);
  if (!startHead) return { kind: 'cant', why: 'the page has no draft', lasting: false };
  // What it can't put in, it says before taking the grant, which would hold others off.
  let first: Awaited<ReturnType<typeof targetOn>> | null = await targetOn(
    ports,
    opened,
    built,
    startHead,
  );
  if (first.kind === 'cant') return first;
  // One join at a time, keyed by the ended session, so two editors don't both put it in.
  try {
    const asked = await transport.send({ joinId, messages: [], fold: sessionId });
    const grant = asked.grant;
    if (!grant || grant.lapsed || grant.holder.joinId !== joinId) return { kind: 'elsewhere' };
  } catch (error) {
    // Caught up and deleted meanwhile, or not served for catching up any more.
    if (error instanceof ApiError && ['not-found', 'forbidden'].includes(error.code)) {
      return { kind: 'elsewhere' };
    }
    return passing(error);
  }
  const { document, latest } = built;
  let head: RevisionId | null = startHead;
  let result: CaughtUp | null = null;
  for (let tries = 0; tries < 4 && !result; tries++) {
    if (!head) return { kind: 'cant', why: 'the page has no draft', lasting: false };
    const target = first ?? (await targetOn(ports, opened, built, head));
    first = null;
    if (target.kind === 'cant') return target;
    if (target.kind === 'held') {
      result = { kind: 'held' };
      break;
    }
    const revisionId = newId(RevisionId);
    try {
      const saved = await ports.saveDraft({
        basedOn: head,
        revisionId,
        payload: target.payload,
        linkChoices: linkChoices(document),
      });
      result = {
        kind: 'saved',
        revisionId: saved.revisionId,
        basedOn: head,
        payload: saved.payload,
        overlapped: target.overlapped,
      };
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'stale-head') throw error;
      // Someone saved first: put it in on the new head.
      const detail = error.detail as { draftHead?: unknown } | undefined;
      const parsed = RevisionId.safeParse(detail?.draftHead);
      head = parsed.success ? parsed.data : null;
    }
  }
  if (!result) return { kind: 'cant', why: 'the page kept changing', lasting: false };
  // What the session placed, never more, naming the draft that holds it: then the server deletes it.
  const named = result.kind === 'saved' ? result.revisionId : (head ?? latest.revisionId);
  const message = sealLiveMessage({
    sender: ctx.identity,
    binding: liveBinding(opened),
    kind: 'saved',
    joinId,
    seq: 1,
    clock: 0,
    content: stateContent(named, document.stateBytes()),
  });
  for (let tries = 0; ; tries++) {
    try {
      await transport.send({
        joinId,
        messages: [{ message, covers: served.position }],
        fold: sessionId,
      });
      break;
    } catch (error) {
      // Saved already: the next to catch up finds the head holds it.
      if (tries >= 2 || (error instanceof ApiError && error.status > 0)) break;
    }
  }
  return result;
}

// What to save on `head` so it holds the ended document: the document on
// top of it, when it is the session's latest draft; otherwise the ended
// document's changes merged onto it from the latest draft of the session
// in its signed chain, the head's text staying where both changed one part.
async function targetOn(
  ports: ParticipantPorts,
  opened: OpenedLiveSession,
  built: Built,
  head: RevisionId,
): Promise<
  | { kind: 'save'; payload: PagePayload; overlapped: number }
  | { kind: 'held' }
  | { kind: 'cant'; why: string; lasting: boolean }
> {
  const { document, latest } = built;
  const sessionId = opened.record.subjectId;
  const headDraft = await ports.openDraft(head);
  const ours = (base: PagePayload) => {
    const payload = withoutLive(document.payload(base));
    const table = base.extensions[LINKS_NAMESPACE];
    return table === undefined
      ? payload
      : { ...payload, extensions: { ...payload.extensions, [LINKS_NAMESPACE]: table } };
  };
  if (head === latest.revisionId) {
    if (!built.unsaved) return { kind: 'held' };
    return { kind: 'save', payload: ours(headDraft.payload), overlapped: 0 };
  }
  // A draft from outside under other keys is never merged, as for a fold.
  if (!sameKeys(headDraft, opened)) {
    return { kind: 'cant', why: 'the page’s draft is under other keys now', lasting: false };
  }
  // The latest draft of the ended session in the head's signed chain.
  let base: { payload: PagePayload; state: LiveState } | null = null;
  let at: OpenedDraft | null = headDraft;
  for (let steps = 0; at && steps < CHAIN_STEPS; steps++) {
    if (at.revisionId === latest.revisionId) {
      base = latest;
      break;
    }
    if (ofAnotherSession(at, sessionId)) {
      // A later session's starter could open this one, and would have caught it up.
      return {
        kind: 'cant',
        why: 'the page was saved in a later live session since',
        lasting: false,
      };
    }
    if (at.revisionId === built.start.revisionId) {
      // Its base, with the first snapshot's state.
      if (sameKeys(at, opened)) base = built.start;
      break;
    }
    const state = sessionState(at.payload, at.revisionId, sessionId);
    if (state && sessionDraft(at, opened, built.signers)) {
      base = { payload: at.payload, state };
      break;
    }
    at = at.basedOn ? await ports.openDraft(at.basedOn) : null;
  }
  if (!base)
    return { kind: 'cant', why: 'the page’s drafts since don’t come from it', lasting: false };
  // Served cut back: its document lacks what a draft of it holds.
  if (!holdsState(document.state(), base.state)) {
    return { kind: 'cant', why: 'it holds less than a draft of it', lasting: false };
  }
  const merge = mergePayloads(
    heldPayload(base.payload),
    heldPayload(headDraft.payload),
    heldPayload(ours(headDraft.payload)),
  );
  // Where both changed one part, the head's text stays.
  let resolved = resolve(
    merge,
    Object.fromEntries(merge.overlaps.map((overlap) => [overlap.id, 'yours' as const])),
    { review: false },
  );
  const overlapped = merge.overlaps.length;
  for (let round = 0; !resolved.ok && round < 8; round++) {
    resolved = resolve(
      resolved.merge,
      Object.fromEntries(resolved.merge.overlaps.map((overlap) => [overlap.id, 'yours' as const])),
      { review: false },
    );
  }
  if (!resolved.ok) return { kind: 'cant', why: 'its changes didn’t merge', lasting: false };
  // The head's own extensions the document never holds stay: its link table and notes.
  const kept = Object.fromEntries(
    Object.entries(headDraft.payload.extensions).filter(
      ([namespace]) => namespace === LINKS_NAMESPACE || namespace === 'wikistow.overlaps',
    ),
  );
  const payload = withoutLive({
    ...resolved.payload,
    extensions: { ...resolved.payload.extensions, ...kept },
  });
  if (samePayload(heldPayload(payload), heldPayload(headDraft.payload))) return { kind: 'held' };
  return { kind: 'save', payload, overlapped };
}

// The choices between pages of one title the session made, which a save's link table keeps.
function linkChoices(document: LiveDocument): Map<string, PageId> {
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
