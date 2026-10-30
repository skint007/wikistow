// What the CLI's exit status says, so an agent can branch on it without
// reading any text, and how each failure maps to one.
import { ApiError, CryptoError, kilobytes, PageTooLarge } from '@wikistow/client';

export const EXIT = {
  ok: 0,
  /** Anything not below: a network failure, a server error, a refusal. */
  failed: 1,
  usage: 2,
  /** A stale base or another write in the way. `--json` names the heads. */
  conflict: 3,
  /** Missing, or not shared with this agent: the two look the same. */
  notFound: 4,
  /** The key file can't be opened: no key file, a wrong passphrase, no way to ask for one. */
  locked: 5,
  /** The person, an administrator or a password change revoked this agent. */
  revoked: 6,
  /** This agent holds no key for it yet: its person's app must unlock and seal it. */
  missingKeys: 7,
  /** The server sent something that failed a check. Possibly an attack. */
  trust: 8,
  /**
   * Done, but what the session learned (first-seen pins, the contacts
   * mark) wasn't saved to the local state: fix the cause before the next run.
   */
  stateNotSaved: 9,
} as const;

export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

/**
 * The CLI's own failures, each with a code for `--json`. Their messages
 * are the CLI's own text, printed as they are: literals, checked IDs, and
 * what the user gave it, such as paths. Never server or library text.
 */
export type CliErrorCode =
  | 'usage'
  | 'locked'
  | 'not-enrolled'
  | 'wrong-passphrase'
  | 'secret-store-missing'
  | 'unpublished'
  | 'not-found'
  | 'cancelled'
  | 'expired'
  | 'journal-mismatch'
  | 'stale-head'
  | 'state-unreadable'
  | 'not-in-record'
  | 'published-elsewhere'
  | 'forbidden'
  | 'failed';

const CLI_EXIT: Record<CliErrorCode, ExitStatus> = {
  usage: EXIT.usage,
  locked: EXIT.locked,
  'not-enrolled': EXIT.locked,
  'wrong-passphrase': EXIT.locked,
  'secret-store-missing': EXIT.locked,
  unpublished: EXIT.notFound,
  'not-found': EXIT.notFound,
  cancelled: EXIT.failed,
  expired: EXIT.failed,
  'journal-mismatch': EXIT.conflict,
  // Checked here against the heads the server lists, before anything is sent.
  'stale-head': EXIT.conflict,
  // The local state is authenticated: a file that doesn't open was changed.
  'state-unreadable': EXIT.trust,
  'not-in-record': EXIT.revoked,
  'published-elsewhere': EXIT.failed,
  // The server's refusal, in the CLI's words for the command (`page copy`).
  forbidden: EXIT.failed,
  failed: EXIT.failed,
};

export class CliError extends Error {
  readonly code: CliErrorCode;
  /** IDs the failure names, such as a page's current heads: for `--json`. */
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: CliErrorCode,
    message: string,
    options?: ErrorOptions & { detail?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = 'CliError';
    this.code = code;
    this.detail = options?.detail;
  }
}

/**
 * What running a command again does after its change may have been made:
 * with the same idempotency key, `resend` sends the first run's change
 * again, which can't make it twice; with no key, `unkeyed` could. `check`:
 * the server refused the first run's change, resent after it stopped
 * keeping the key, which it may be only because it was made
 * (`Journal.inconclusive`), and would refuse it again. `again`: a command
 * that names the state it changes (unpublish, publish-to) finds its own
 * change done, or in the way, when it is run again as it was.
 */
export type Retry = 'resend' | 'unkeyed' | 'check' | 'again';

/**
 * A command failed after its change went out, with no answer or a server
 * failure (`outcomeUnknown`), or after the answer came back, or with a
 * refusal that doesn't show it wasn't made: the change may have been made.
 * `retry` says what running the command again does.
 */
export class ChangeMayHaveHappened extends Error {
  readonly retry: Retry;

  constructor(cause: unknown, retry: Retry) {
    super('The change may have been made', { cause });
    this.name = 'ChangeMayHaveHappened';
    this.retry = retry;
  }
}

/** A refusal as `--json` reports it: the code, and any IDs it names. */
export type Failure = {
  exit: ExitStatus;
  code: string;
  /** The CLI's own words, printed as they are (`CliError`). */
  message: string;
  /** The change may have been made: see `ChangeMayHaveHappened`. */
  outcomeUnknown?: true;
  /** The server's or the library's words, foreign text: printed only escaped. */
  reason?: string;
  detail?: Record<string, unknown>;
};

const API_EXIT: Partial<Record<ApiError['code'], ExitStatus>> = {
  'stale-head': EXIT.conflict,
  'permission-version': EXIT.conflict,
  duplicate: EXIT.conflict,
  'enrollment-state': EXIT.conflict,
  'not-found': EXIT.notFound,
  unauthenticated: EXIT.revoked,
  'account-suspended': EXIT.revoked,
  // The share moved to a key version this agent's person hasn't sealed it.
  'key-version': EXIT.missingKeys,
};

const CRYPTO_EXIT: Partial<Record<CryptoError['code'], ExitStatus>> = {
  'missing-key': EXIT.missingKeys,
  'agent-revoked': EXIT.revoked,
  'unsupported-format': EXIT.failed,
  'kdf-failed': EXIT.locked,
};

const MESSAGES: Record<ExitStatus, string> = {
  [EXIT.ok]: 'Done',
  [EXIT.failed]: 'The command failed',
  [EXIT.usage]: 'Usage error',
  [EXIT.conflict]: 'Someone else changed it first; nothing was overwritten',
  [EXIT.notFound]: 'Not found, or not shared with this agent',
  [EXIT.locked]: 'The key file is locked',
  [EXIT.revoked]: 'This agent’s credential was revoked; enroll again',
  [EXIT.missingKeys]:
    'This agent holds no key for that yet; its person’s app seals it at their next unlock',
  [EXIT.trust]: 'The server sent something that failed a check; this could be an attack',
  [EXIT.stateNotSaved]:
    'Done: don’t run the command again. But the CLI couldn’t save what it learned to its local ' +
    'state; fix that before the next command',
};

/** A command did what it was asked, then failed to keep what its session learned. */
export function stateNotSaved(error: unknown): Failure {
  const { reason, message } = classify(error);
  return {
    exit: EXIT.stateNotSaved,
    code: 'state-not-saved',
    message: MESSAGES[EXIT.stateNotSaved],
    reason: reason ?? message,
  };
}

/** Plainer words for refusals an agent can act on, where the exit status alone is too broad. */
const API_MESSAGES: Partial<Record<ApiError['code'], string>> = {
  // An agent may do only what its share and its person both may there (protocol section 9.5).
  forbidden: 'This agent or its person may not do that here (to publish, both must be allowed to)',
  'permission-version':
    'Who has access there changed since this agent looked, so it was refused; look again',
  'rate-limited': 'The server is busy; wait a little and try again',
  'request-timeout': 'The server gave up waiting for the request; try again',
  'payload-too-large': 'That is more than the server takes in one request',
  'storage-full': 'The space has no room left for that',
};

const RETRY_MESSAGES: Record<Retry, string> = {
  resend:
    'The change may have been made. Run the same command with the same ' +
    '--idempotency-key: that is safe, and can’t make it twice',
  unkeyed:
    'The change may have been made. Check (tree, page read) before trying again: ' +
    'without an --idempotency-key, running it again could make it twice',
  check:
    'This change may already have been made: it first went out over a day ago, longer than ' +
    'the server remembers its key, and things have changed since, perhaps by it. Check ' +
    '(tree, page read --draft) before trying again with a new --idempotency-key',
  again:
    'The change may have been made. Run the same command again: if it was made, that finds ' +
    'it done, or refuses it as stale and names what is there now, unless someone changes it ' +
    'there meanwhile',
};

/** How a failure ends the CLI: its status, code and what to say. */
export function classify(error: unknown): Failure {
  if (error instanceof ChangeMayHaveHappened) {
    const failure = { ...classify(error.cause), outcomeUnknown: true } as const;
    if (error.retry === 'check') {
      // Not the conflict its code says: nothing tells whether it was made.
      return { ...failure, exit: EXIT.failed, message: RETRY_MESSAGES.check };
    }
    return { ...failure, message: RETRY_MESSAGES[error.retry] };
  }
  // The API client reports anything its fetch throws as `network`; the
  // journal's own refusals come through that way.
  if (error instanceof ApiError && error.code === 'network' && error.cause instanceof CliError) {
    return classify(error.cause);
  }
  if (error instanceof CliError) {
    const { code, message, detail } = error;
    return { exit: CLI_EXIT[code], code, message, ...(detail ? { detail } : {}) };
  }
  if (error instanceof ApiError) {
    const exit =
      API_EXIT[error.code] ?? (error.code === 'invalid-request' ? EXIT.usage : EXIT.failed);
    const detail = Object.fromEntries(
      Object.entries(error.detail).filter(([, value]) => value !== undefined),
    );
    return {
      exit,
      code: error.code,
      message: API_MESSAGES[error.code] ?? MESSAGES[exit],
      reason: error.message,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  }
  // Refused before anything was sent, like a usage error: what was given is too large.
  if (error instanceof PageTooLarge) {
    const { part, bytes, limit } = error;
    const what = part === 'markdown' ? 'of Markdown' : 'with its links and attachment list';
    return {
      exit: EXIT.usage,
      code: 'too-large',
      message: `A page holds at most ${kilobytes(limit)} ${what}; nothing changed`,
      reason: error.message,
      detail: { part, bytes, limit },
    };
  }
  if (error instanceof CryptoError) {
    const exit = CRYPTO_EXIT[error.code] ?? EXIT.trust;
    return { exit, code: error.code, message: MESSAGES[exit], reason: error.message };
  }
  return {
    exit: EXIT.failed,
    code: 'failed',
    message: MESSAGES[EXIT.failed],
    reason: error instanceof Error ? error.message : String(error),
  };
}
