// What a receiver keeps of a session's joins (protocol section 5.10): who
// the server has listed, each join's Yjs client, the stored messages taken
// from it in `seq` order and the highest `clock` each has signed, so a
// message is checked against what its join and the others have signed,
// never against what the server says.
import type { IdentityId, InstallationId, JoinId, LiveSessionId } from '@wikistow/contracts';
import { CryptoError } from '../errors.ts';
import type { ClockRange, DecodedUpdate, StructId } from './decode.ts';
import { isStoredKind, liveClientId, type LiveHeader, type OpenedLiveMessage } from './messages.ts';

/** A join, everywhere in a session: a person and one of their join IDs. */
export type JoinRef = { senderId: IdentityId; joinId: JoinId };

/** A join as the server lists it. `parent` is the join a save's own join belongs to. */
export type ListedJoin = JoinRef & {
  senderKeyVersion: number;
  parent: JoinRef | null;
  present: boolean;
};

/** What a receiver does with a message (`LiveJoins.check`). */
export type LiveVerdict =
  /** It fits: apply it, then `take` it. */
  | { kind: 'take' }
  /** A repeat of one already taken: drop it. */
  | { kind: 'repeat' }
  /**
   * Hold it: a `seq` gap, which takes the session out of step if still open
   * 30 s later while that join is present; or an origin in another present
   * join's typing not taken yet, which it can't catch up with if no message
   * of that join signs it within 30 s.
   */
  | { kind: 'hold'; reason: 'gap' }
  | { kind: 'hold'; reason: 'origin'; waitFor: StructId }
  /** Refused (`binding-mismatch`): the app can't catch up. */
  | { kind: 'refuse'; why: string }
  /** Its sender signed two stored messages at one `seq`: out of step, and report them. */
  | { kind: 'equivocation'; sender: JoinRef };

type Join = ListedJoin & {
  clientId: number;
  /** The highest `seq` taken, 0 for none. */
  seq: number;
  /** The `clock` of the last stored message taken, 0 for none. */
  clock: number;
  /** Every stored message taken, by `seq`, so a second one at a `seq` shows. */
  taken: Map<number, { payloadHash: string; kind: string }>;
  /** Refused for good: a client ID taken already, a parent of another person, or folded as gone. */
  refused: string | null;
};

const key = (join: JoinRef) => `${join.senderId} ${join.joinId}`;

/**
 * One app's view of a session's joins. A join, once listed, stays listed
 * with its person, key version and parent, whatever the server lists later;
 * only whether it is present changes.
 */
export class LiveJoins {
  readonly #installationId: InstallationId;
  readonly #sessionId: LiveSessionId;
  readonly #starter: JoinRef;
  readonly #joins = new Map<string, Join>();
  readonly #byClient = new Map<number, Join>();

  constructor({
    installationId,
    sessionId,
    starter,
  }: {
    installationId: InstallationId;
    sessionId: LiveSessionId;
    /** The record's signer and the join its payload names, which sends the first snapshot. */
    starter: JoinRef;
  }) {
    this.#installationId = installationId;
    this.#sessionId = sessionId;
    this.#starter = starter;
  }

  /**
   * Take in the server's list of joins, past and present. A join new to
   * this app keeps the first person, key version and parent it was listed
   * with, and is refused for good if its derived client ID is that of a
   * join listed before it, or if it is a save's own join listed under a
   * join of another person. A join the list leaves out stays listed, as not
   * present.
   */
  list(joins: readonly ListedJoin[]): void {
    const now = new Set(joins.map(key));
    for (const join of this.#joins.values()) {
      if (!now.has(key(join))) join.present = false;
    }
    for (const listed of joins) {
      const known = this.#joins.get(key(listed));
      if (known) {
        known.present = listed.present;
        continue;
      }
      const clientId = liveClientId({
        installationId: this.#installationId,
        sessionId: this.#sessionId,
        senderId: listed.senderId,
        senderKeyVersion: listed.senderKeyVersion,
        joinId: listed.joinId,
      });
      const refused = this.#byClient.has(clientId)
        ? 'its client ID is an earlier join’s'
        : listed.parent && listed.parent.senderId !== listed.senderId
          ? 'it is listed under another person’s join'
          : null;
      const join: Join = {
        ...listed,
        parent: listed.parent && { ...listed.parent },
        clientId,
        seq: 0,
        clock: 0,
        taken: new Map(),
        refused,
      };
      this.#joins.set(key(join), join);
      if (!refused) this.#byClient.set(clientId, join);
    }
  }

  /** Whether the server has listed this join, at this key version, and it isn't refused. */
  listed(header: Pick<LiveHeader, 'senderId' | 'senderKeyVersion' | 'joinId'>): boolean {
    const join = this.#joins.get(key(header));
    return (
      join !== undefined &&
      join.refused === null &&
      join.senderKeyVersion === header.senderKeyVersion
    );
  }

  /** The Yjs client a listed join writes under. */
  clientOf(join: JoinRef): number | undefined {
    const known = this.#joins.get(key(join));
    return known && !known.refused ? known.clientId : undefined;
  }

  /** The join that writes under `client`, if any listed join derives it. */
  joinOf(client: number): (ListedJoin & { clientId: number }) | undefined {
    const join = this.#byClient.get(client);
    return join && { ...join, parent: join.parent && { ...join.parent } };
  }

  /** The highest `clock` the join writing under `client` has signed in a message taken, 0 for none. */
  signed(client: number): number {
    return this.#byClient.get(client)?.clock ?? 0;
  }

  /**
   * Start a join's order from its latest kept message at or before the
   * position a newcomer's snapshot covers, which its sender signed: the
   * newcomer takes each later message by the rules of `check`.
   */
  startFrom(message: OpenedLiveMessage): void {
    const join = this.#require(message);
    if (!isStoredKind(message.kind)) {
      throw new CryptoError('malformed', 'A join’s order starts from a stored message');
    }
    if (join.seq > 0) throw new CryptoError('malformed', 'This join’s order has started already');
    this.#record(join, message);
  }

  /**
   * Stop taking a join's messages for good, as once the app has folded in
   * its changes as gone (section 5.10, **Serving and relaying**), so they
   * can't go in twice.
   */
  refuse(join: JoinRef, why: string): void {
    const known = this.#joins.get(key(join));
    if (!known) return;
    known.refused ??= why;
    if (this.#byClient.get(known.clientId) === known) this.#byClient.delete(known.clientId);
  }

  /**
   * Check a message, opened, against its join's order and clock (section
   * 5.10), with its update decoded if it holds one: an `update`'s plaintext,
   * a `snapshot`'s state. Changes nothing; `take` it once applied.
   *
   * - A stored message is taken in `seq` order: a repeat with the same
   *   `payloadHash` is dropped, one at a `seq` taken already with another
   *   hash or kind is equivocation, one below the last taken is refused,
   *   and one past the next is held for a gap.
   * - Its `clock` is the join's last one plus the lengths of its structs
   *   under the join's client, which start exactly there. A `saved` and a
   *   later snapshot hold none, and the first snapshot (`seq` 1 of the
   *   starter's join) holds structs under that client alone.
   * - An `update` adds structs under its join's client only; each origin
   *   under another client is within what that client's join has signed,
   *   or held while that join is present; and each deleted range is within
   *   what its client's join has signed, this message included.
   *
   * A presence is taken as it comes, and never checked against stored ones.
   */
  check(message: OpenedLiveMessage, update?: DecodedUpdate): LiveVerdict {
    if (message.kind === 'presence') return { kind: 'take' };
    const join = this.#joins.get(key(message));
    if (!join || join.refused) return { kind: 'refuse', why: 'the join isn’t one this app takes' };
    const seen = join.taken.get(message.seq);
    if (seen) {
      return seen.payloadHash === message.payloadHash && seen.kind === message.kind
        ? { kind: 'repeat' }
        : { kind: 'equivocation', sender: { senderId: join.senderId, joinId: join.joinId } };
    }
    if (message.seq <= join.seq) return { kind: 'refuse', why: 'its seq is below the last taken' };
    if (message.seq !== join.seq + 1) return { kind: 'hold', reason: 'gap' };
    if ((message.kind === 'saved') !== (update === undefined)) {
      throw new CryptoError('malformed', 'Check an update or snapshot with its decoded update');
    }
    const first =
      message.kind === 'snapshot' && message.seq === 1 && key(join) === key(this.#starter);
    if (key(join) === key(this.#starter) && message.seq === 1 && !first) {
      return { kind: 'refuse', why: 'the starter’s first message isn’t the first snapshot' };
    }
    const own = update?.structs.find((section) => section.client === join.clientId);
    const length = own ? own.end - own.start : 0;
    if (own && own.start !== join.clock) {
      return { kind: 'refuse', why: 'its structs don’t start at its join’s last clock' };
    }
    if (message.clock !== join.clock + length) {
      return { kind: 'refuse', why: 'its clock isn’t its join’s last plus its own structs' };
    }
    if (message.kind === 'snapshot') {
      if (first) {
        return update && update.structs.every((section) => section.client === join.clientId)
          ? checkDeletes(update.deletes, (client) => (client === join.clientId ? message.clock : 0))
          : { kind: 'refuse', why: 'the first snapshot holds structs of another client' };
      }
      // A later snapshot's own ranges are checked as the newcomer opens it
      // (`openSnapshot`); a join already in the session never applies one.
      return own
        ? { kind: 'refuse', why: 'a later snapshot holds structs under its own join’s client' }
        : { kind: 'take' };
    }
    if (message.kind === 'saved' || !update) return { kind: 'take' };
    if (update.structs.some((section) => section.client !== join.clientId)) {
      return { kind: 'refuse', why: 'it adds structs under another client' };
    }
    const signed = (client: number) =>
      client === join.clientId ? message.clock : this.signed(client);
    for (const item of own?.items ?? []) {
      for (const origin of [item.origin, item.rightOrigin]) {
        if (!origin || origin.client === join.clientId || origin.clock < signed(origin.client)) {
          continue;
        }
        const from = this.#byClient.get(origin.client);
        if (from?.present) return { kind: 'hold', reason: 'origin', waitFor: origin };
        return { kind: 'refuse', why: 'it is placed next to typing nobody signed' };
      }
    }
    return checkDeletes(update.deletes, signed);
  }

  /** Record a message `check` passed and the app applied: its `seq`, `clock` and hash. */
  take(message: OpenedLiveMessage): void {
    if (message.kind === 'presence') return;
    const join = this.#require(message);
    if (message.seq !== join.seq + 1) {
      throw new CryptoError('malformed', 'Messages are taken in their join’s seq order');
    }
    this.#record(join, message);
  }

  #record(join: Join, message: OpenedLiveMessage): void {
    join.seq = message.seq;
    join.clock = message.clock;
    join.taken.set(message.seq, { payloadHash: message.payloadHash, kind: message.kind });
  }

  #require(ref: JoinRef): Join {
    const join = this.#joins.get(key(ref));
    if (!join || join.refused)
      throw new CryptoError('binding-mismatch', 'Not a join this app takes');
    return join;
  }
}

// Every deleted range within what its client's join has signed: nothing is
// deleted before it is typed.
function checkDeletes(
  deletes: ReadonlyMap<number, readonly ClockRange[]>,
  signed: (client: number) => number,
): LiveVerdict {
  for (const [client, ranges] of deletes) {
    const limit = signed(client);
    if (ranges.some((range) => range.clock + range.length > limit)) {
      return { kind: 'refuse', why: 'it deletes text nobody has signed as typed' };
    }
  }
  return { kind: 'take' };
}
