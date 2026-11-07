import { RevisionId } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import {
  availability,
  CHAT_SENDS_FIRST,
  NEEDS_CONNECTION,
  SENDS_FIRST,
  waitingOf,
  type ActionKind,
  type Waiting,
} from '../src/shell/availability.ts';

// What each kind of action does offline and while a change made offline
// waits (ADR 0009, decisions 7 and 8): ✓ runs, else the hint its control shows.
const OK = '✓';
const NEEDS = NEEDS_CONNECTION;
const HELD = SENDS_FIRST;

//                              online:  none  changed made   offline: none  changed made
const TABLE: Record<ActionKind, [string, string, string, string, string, string]> = {
  open: /*                    */ [OK, OK, OK, OK, OK, OK],
  'new-page': /*              */ [OK, OK, OK, OK, OK, OK],
  'new-folder': /*            */ [OK, OK, OK, OK, OK, OK],
  move: /*                    */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  copy: /*                    */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  'publish-elsewhere': /*     */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  publish: /*                 */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  restore: /*                 */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  drag: /*                    */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  into: /*                    */ [OK, OK, HELD, OK, OK, HELD],
  tick: /*                    */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  'chat-edit': /*             */ [OK, CHAT_SENDS_FIRST, CHAT_SENDS_FIRST, NEEDS, NEEDS, NEEDS],
  server: /*                  */ [OK, OK, HELD, NEEDS, NEEDS, NEEDS],
};

const STATES: { offline: boolean; waiting: Waiting }[] = [false, true].flatMap((offline) =>
  (['none', 'changed', 'made'] as const).map((waiting) => ({ offline, waiting })),
);

describe('what can run now', () => {
  it.each(Object.entries(TABLE))('%s', (kind, expected) => {
    const got = STATES.map((state) => {
      const now = availability(kind as ActionKind, state);
      return now.allowed ? OK : now.hint;
    });
    expect(got).toEqual(expected);
  });

  it('counts a page made offline, and a folder, as made, and a draft saved offline as changed', () => {
    const made = { parentId: null, revisionId: RevisionId.parse('A'.repeat(22)) };
    expect(waitingOf(null)).toBe('none');
    expect(waitingOf({ kind: 'page', newPage: null })).toBe('changed');
    expect(waitingOf({ kind: 'page', newPage: made })).toBe('made');
    expect(waitingOf({ kind: 'folder' })).toBe('made');
  });
});
