// What a live session's draft holds (protocol section 5.5, `wikistow.live`):
// the draft's own revision ID, the session, the state of the document it
// was written from, and who edited it. A draft counts as the session's only
// when the extension names that draft itself, so a copy an older writer
// carried into its own save counts as none.
import {
  IdentityId,
  LIVE_NAMESPACE,
  LiveExtension,
  type LiveSessionId,
  type RevisionId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { fromBase64, toBase64 } from '../encoding.ts';
import type { PagePayload } from '../payload.ts';
import { decodeState, type LiveState } from './decode.ts';

export { LIVE_NAMESPACE, LiveExtension };

/** A draft's `wikistow.live`, read. */
export type DraftLive =
  /** None, or one that doesn't match the schema, names another version, or whose state doesn't decode. */
  | { kind: 'none' }
  /** A newer format: an app in the session says to update, and edits as a writer outside it. */
  | { kind: 'newer-format' }
  | { kind: 'live'; extension: LiveExtension; state: LiveState };

/** Read `wikistow.live` from the draft `revisionId`'s payload (section 5.5). */
export function draftLive(payload: PagePayload, revisionId: RevisionId): DraftLive {
  const raw = payload.extensions[LIVE_NAMESPACE];
  if (raw === undefined) return { kind: 'none' };
  const format = (raw as { format?: unknown } | null)?.format;
  if (typeof format === 'number' && Number.isSafeInteger(format) && format > 1) {
    return { kind: 'newer-format' };
  }
  const parsed = LiveExtension.safeParse(raw);
  if (!parsed.success || parsed.data.revision !== revisionId) return { kind: 'none' };
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(parsed.data.state);
  } catch {
    return { kind: 'none' };
  }
  const state = decodeState(bytes);
  return state ? { kind: 'live', extension: parsed.data, state } : { kind: 'none' };
}

/**
 * The state a draft holds for `sessionId`, when its `wikistow.live` names
 * the draft itself and the session; `null` otherwise. The rest of what
 * makes a draft the session's (section 5.10, **Saving**: a signer with a
 * join in the session, and in a share the record's key version) is the
 * caller's to check, from the draft's record.
 */
export function sessionState(
  payload: PagePayload,
  revisionId: RevisionId,
  sessionId: LiveSessionId,
): LiveState | null {
  const live = draftLive(payload, revisionId);
  return live.kind === 'live' && live.extension.session === sessionId ? live.state : null;
}

/**
 * `payload` with the `wikistow.live` a session's saver writes into the
 * draft `revision`: the session, the document's state (`stateBytes`) and
 * who edited it since the page's latest publication.
 */
export function withLive(
  payload: PagePayload,
  live: {
    revision: RevisionId;
    session: LiveSessionId;
    state: Uint8Array;
    with: readonly IdentityId[];
  },
): PagePayload {
  const extension: LiveExtension = {
    format: 1,
    revision: live.revision,
    session: live.session,
    state: toBase64(live.state),
    with: [...new Set(live.with)],
  };
  return {
    ...payload,
    extensions: { ...payload.extensions, [LIVE_NAMESPACE]: extension as z.core.util.JSONType },
  };
}

/** `payload` without `wikistow.live`, as publishing, detaching, copies and publications into other spaces write it. */
export function withoutLive<P extends Pick<PagePayload, 'extensions'>>(payload: P): P {
  const { [LIVE_NAMESPACE]: _live, ...extensions } = payload.extensions;
  return { ...payload, extensions };
}
