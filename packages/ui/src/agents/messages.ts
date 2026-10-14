import { CryptoError } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { sharingMessage } from '../sharing/messages';

// Where agent steps differ from sharing ones. The rest are the same words.
const REFUSED: Partial<Record<ApiError['code'], string>> = {
  'not-found':
    'No agent is waiting with that code. Check it against the CLI, or start again there: codes last ten minutes.',
  'rate-limited': 'Too many wrong codes for now. Wait ten minutes, then try again.',
  'enrollment-state':
    'This enrollment has moved on: it expired, was cancelled, or was already approved. Start again in the CLI.',
  duplicate: 'Another of your agents has that name. Pick another.',
  forbidden: 'You can’t give an agent more access than you have there.',
  'binding-mismatch':
    'The server turned this enrollment down as not matching, so nothing changed. Start again in the CLI.',
};

const STOPPED: Partial<Record<CryptoError['code'], string>> = {
  'binding-mismatch':
    'This enrollment can’t be approved any more: it expired or was refused. Start again in the CLI.',
  'fingerprint-mismatch':
    'The agent’s keys changed since the fingerprint was shown, so nothing was approved. Start again in the CLI.',
  'wrong-recipient': 'That agent isn’t on your list any more. Look at the list again.',
  'region-mismatch':
    'This folder became a share, or stopped being one, while you were working. Pick it again.',
};

/** A short message for a failed agent action, in this app's own words. */
export function agentMessage(error: unknown): string {
  if (error instanceof PartlyDone || error instanceof RecordAhead) return error.message;
  if (error instanceof ApiError && REFUSED[error.code]) return REFUSED[error.code] ?? '';
  if (error instanceof CryptoError && STOPPED[error.code]) return STOPPED[error.code] ?? '';
  return sharingMessage(error);
}

/**
 * The agent was approved, but some picks in the owner region weren't made:
 * what went wrong, in this app's words, and which picks to add again.
 */
export class PartlyDone extends Error {
  readonly agentId: string;
  readonly failed: readonly string[];

  constructor(agentId: string, failed: readonly string[], cause: unknown) {
    super(
      `The agent is approved, but ${failed.length === 1 ? 'one folder' : `${failed.length} folders`} couldn’t be added: ${agentMessage(cause)} Add ${failed.length === 1 ? 'it' : 'them'} again on the Agents page.`,
    );
    this.name = 'PartlyDone';
    this.agentId = agentId;
    this.failed = failed;
  }
}

/**
 * A change to what an agent may reach went into the person's own record,
 * but the server call after it failed: the record is ahead of the server.
 * `repair` says the folder's row offers to bring the server in line.
 */
export class RecordAhead extends Error {
  constructor(repair: boolean, cause: unknown) {
    super(
      `Your own record is updated, but the server isn’t yet. Try again${repair ? ', or use the button by the folder below' : ''}.`,
      { cause },
    );
    this.name = 'RecordAhead';
  }
}
