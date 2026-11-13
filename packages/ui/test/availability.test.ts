import { RevisionId } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import {
  availability,
  CHAT_SENDS_FIRST,
  moveAvailability,
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
  move: /*                    */ [OK, OK, OK, OK, OK, OK],
  copy: /*                    */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  'publish-elsewhere': /*     */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  publish: /*                 */ [OK, OK, HELD, OK, OK, HELD],
  'publish-linked': /*        */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  restore: /*                 */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  drag: /*                    */ [OK, OK, OK, OK, OK, OK],
  reorder: /*                 */ [OK, OK, HELD, OK, OK, HELD],
  into: /*                    */ [OK, OK, HELD, OK, OK, HELD],
  tick: /*                    */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  'chat-edit': /*             */ [OK, CHAT_SENDS_FIRST, CHAT_SENDS_FIRST, NEEDS, NEEDS, NEEDS],
  rename: /*                  */ [OK, OK, OK, OK, OK, OK],
  picture: /*                 */ [OK, HELD, HELD, NEEDS, NEEDS, NEEDS],
  delete: /*                  */ [OK, OK, OK, OK, OK, OK],
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

  // A move within one share waits on the device offline, or after what waits
  // for it or its folder; one across a share's edge, or to another space, needs
  // the server, with nothing waiting (#331).
  it.each([
    //            offline  item       place      across  →
    [false, 'none', 'none', false, 'server'],
    [false, 'changed', 'none', false, 'device'],
    [false, 'none', 'made', false, 'device'],
    [true, 'none', 'none', false, 'device'],
    [true, 'made', 'made', false, 'device'],
    [false, 'none', 'none', true, 'server'],
    [false, 'changed', 'none', true, HELD],
    [false, 'none', 'made', true, HELD],
    [true, 'none', 'none', true, NEEDS],
  ] as const)('moves %s %s %s %s: %s', (offline, item, place, across, expected) => {
    const how = moveAvailability({ offline, item, place, across });
    expect(how.route ?? ('hint' in how ? how.hint : null)).toBe(expected);
  });

  it('counts a page made offline, and a folder, as made, and other changes as changed', () => {
    const made = { parentId: null, revisionId: RevisionId.parse('A'.repeat(22)) };
    expect(waitingOf([])).toBe('none');
    expect(waitingOf([{ kind: 'page', newPage: null }])).toBe('changed');
    expect(waitingOf([{ kind: 'page', newPage: made }])).toBe('made');
    expect(waitingOf([{ kind: 'folder' }])).toBe('made');
    expect(waitingOf([{ kind: 'rename' }])).toBe('changed');
    expect(waitingOf([{ kind: 'page', newPage: null }, { kind: 'delete' }])).toBe('changed');
    expect(waitingOf([{ kind: 'move' }, { kind: 'publish' }])).toBe('changed');
  });
});
