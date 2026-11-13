// Snapshots (protocol section 5.10, **`snapshot`**): the first one a
// starter sends with its session record, made from the draft it opened,
// and the check a newcomer makes before it builds its document from one.
// A snapshot's text must equal the revision it names, and it may claim no
// more of anyone's typing than their latest signed message.
import type { IdentityId, JoinId, PageId, RevisionId } from '@wikistow/contracts';
import * as Y from 'yjs';
import { CryptoError } from '../errors.ts';
import type { PrivateIdentity } from '../identity.ts';
import type { PagePayload } from '../payload.ts';
import { decodeUpdate, sameState, type DecodedUpdate } from './decode.ts';
import { documentFromPayload, LiveDocument, samePayload } from './document.ts';
import { draftLive } from './extension.ts';
import type { LiveJoins } from './joins.ts';
import {
  readSnapshot,
  sealLiveMessage,
  stateContent,
  type LiveBinding,
  type LiveMessage,
  type OpenedLiveMessage,
} from './messages.ts';
import type { OpenedLiveSession } from './session.ts';

/**
 * The first snapshot (section 5.10): the draft the session starts from,
 * repaired as a save repairs it, under the starter's client alone, as the
 * starter's message with `seq` 1, and the document it keeps. Refused
 * (`malformed`) for a draft that can't be a document, as one with two refs
 * of one attachment ID.
 */
export function firstSnapshot({
  sender,
  binding,
  joinId,
  clientId,
  revisionId,
  payload,
}: {
  sender: PrivateIdentity;
  binding: LiveBinding;
  /** The join the session payload names. */
  joinId: JoinId;
  /** That join's client (`liveClientId`). */
  clientId: number;
  /** The draft the session starts from, as opened. */
  revisionId: RevisionId;
  payload: PagePayload;
}): { document: LiveDocument; message: LiveMessage } {
  const document = documentFromPayload(payload, clientId);
  const update = Y.encodeStateAsUpdate(document.doc);
  // As for revisions: never send what a strict reader would refuse.
  const decoded = decodeUpdate(update);
  if (decoded.structs.some((section) => section.client !== clientId)) {
    throw new CryptoError('malformed', 'The first snapshot holds another client’s structs');
  }
  const message = sealLiveMessage({
    sender,
    binding,
    kind: 'snapshot',
    joinId,
    seq: 1,
    clock: Y.getState(document.doc.store, clientId),
    content: stateContent(revisionId, update),
  });
  return { document, message };
}

function refuse(why: string): never {
  throw new CryptoError('binding-mismatch', `The snapshot can’t be used: ${why}`);
}

// Every struct range and deleted range within `signed`, by client.
function withinSigned(update: DecodedUpdate, signed: (client: number) => number): void {
  for (const section of update.structs) {
    if (section.end > signed(section.client)) refuse('it claims typing nobody signed');
  }
  for (const [client, ranges] of update.deletes) {
    const limit = signed(client);
    if (ranges.some((range) => range.clock + range.length > limit)) {
      refuse('it deletes text nobody signed as typed');
    }
  }
}

/** A newcomer's document, and whether it is provisional: built from a later snapshot, until it has compared a session draft equal. */
export type OpenedSnapshot = { document: LiveDocument; provisional: boolean };

/**
 * Check a snapshot before a newcomer builds its document from it (section
 * 5.10, **`snapshot`**), or refuse it (`binding-mismatch`):
 *
 * - its plaintext, of a format this app reads (`unsupported-format`
 *   otherwise), names `revision`, which for the first snapshot (`seq` 1 of
 *   the join the record's payload names, from the record's signer) is the
 *   record's `revisionId`;
 * - its state decodes as an update does, and Yjs places each struct in the
 *   document's eight parts, as their kinds allow, leaving nothing pending;
 * - the first snapshot holds structs of its sender's client alone, from
 *   clock 0 to its signed `clock`, and deletes nothing beyond it;
 * - a later one holds no struct of its own join's client, and every struct
 *   range and deleted range in it is under a client of a join and within
 *   the highest `clock` that join has signed in a kept message, the first
 *   snapshot counting for its sender's join (`joins`, started from each
 *   join's latest kept message with `LiveJoins.startFrom`); its revision's
 *   `wikistow.live` names that revision and the session, and the state of
 *   the document built from it is exactly that `state`;
 * - the payload a save would write from the document equals the
 *   revision's (`samePayload`).
 *
 * Whether a later snapshot's revision is a draft of the session by its
 * record (its signer has a join in the session, and in a share it is
 * under the record's key version) is the caller's to check.
 */
export function openSnapshot({
  message,
  session,
  joins,
  revision,
  clientId,
}: {
  message: OpenedLiveMessage;
  session: OpenedLiveSession;
  joins: LiveJoins;
  /** The revision the snapshot names, opened. */
  revision: { revisionId: RevisionId; pageId: PageId; authorId: IdentityId; payload: PagePayload };
  /** The newcomer's own client, for the document it builds. */
  clientId: number;
}): OpenedSnapshot {
  if (message.kind !== 'snapshot') refuse('it isn’t a snapshot');
  const read = readSnapshot(message.content);
  if (read.kind === 'newer-format') {
    throw new CryptoError('unsupported-format', 'Update the app to edit with others');
  }
  if (read.revisionId !== revision.revisionId || revision.pageId !== session.payload.pageId) {
    refuse('it names another revision than the one opened');
  }
  const { starter } = session;
  const first =
    message.senderId === starter.senderId &&
    message.joinId === starter.joinId &&
    message.senderKeyVersion === starter.senderKeyVersion &&
    message.seq === 1;
  const decoded = decodeUpdate(read.state);
  const own = joins.clientOf(message);
  if (own === undefined) refuse('its join isn’t listed');
  if (first) {
    if (read.revisionId !== session.payload.revisionId) {
      refuse('the first snapshot names another draft than the record');
    }
    if (decoded.structs.some((section) => section.client !== own || section.start !== 0)) {
      refuse('the first snapshot holds structs of another client');
    }
    const end = decoded.structs[0]?.end ?? 0;
    if (end !== message.clock) refuse('the first snapshot’s structs don’t end at its clock');
    withinSigned(decoded, (client) => (client === own ? message.clock : 0));
  } else {
    // From a save's own join that has sent no structs (section 5.10).
    const poster = joins.joinOf(own);
    if (!poster?.parent || joins.signed(own) !== 0) {
      refuse('a later snapshot isn’t from a save’s own join');
    }
    if (message.clock !== joins.signed(own)) {
      refuse('a later snapshot’s clock isn’t its join’s last');
    }
    if (decoded.structs.some((section) => section.client === own)) {
      refuse('a later snapshot holds structs under its own join’s client');
    }
    withinSigned(decoded, (client) => joins.signed(client));
  }
  const document = new LiveDocument(clientId);
  const misplaced = document.apply(read.state, 'snapshot');
  if (misplaced.length > 0) refuse(misplaced[0]?.why ?? 'it doesn’t fit the document');
  if (document.pending) refuse('Yjs holds part of it back');
  if (!first) {
    const live = draftLive(revision.payload, revision.revisionId);
    if (live.kind === 'newer-format') {
      throw new CryptoError('unsupported-format', 'Update the app to edit with others');
    }
    if (live.kind !== 'live' || live.extension.session !== session.record.subjectId) {
      refuse('its revision isn’t a draft of the session');
    }
    if (!sameState(document.state(), live.state)) {
      refuse('its state isn’t its revision’s');
    }
  }
  if (!samePayload(document.payload(revision.payload), revision.payload)) {
    refuse('its text isn’t its revision’s');
  }
  return { document, provisional: !first };
}
