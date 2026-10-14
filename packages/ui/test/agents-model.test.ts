import { describe, expect, it } from 'vite-plus/test';
import {
  ancestorsOf,
  checkGroup,
  picksOffRecord,
  recordedAccess,
  sharesItHeld,
  withPick,
  placesIn,
} from '../src/agents/model.ts';

describe('typing back one group of the fingerprint', () => {
  const printed = '1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d 7e8f 9a0b';

  it('refuses another group, or anything else, once four symbols are typed', () => {
    expect(checkGroup(printed, 0, '3c4d')).toBe('mismatch');
    expect(checkGroup(printed, 3, '7a8b9')).toBe('mismatch');
    expect(checkGroup(printed, 10, '1a2b')).toBe('mismatch');
    // The group asked for matches, however it was typed.
    expect(checkGroup(printed, 9, ' 9A0B ')).toBe('match');
  });
});

describe('where an agent can be picked', () => {
  // home ─ recipes ─ soups
  //      └ travel (shared)
  // ??? (a folder this app can't name)
  const folders = [
    { id: 'home', parentId: null, name: 'Home' },
    { id: 'recipes', parentId: 'home', name: 'Recipes' },
    { id: 'soups', parentId: 'recipes', name: 'Soups' },
    { id: 'travel', parentId: 'home', name: 'Travel' },
    { id: 'hidden', parentId: null, name: null },
  ];
  const travel = { shareId: 's1', rootId: 'travel', role: 'owner' as const, canPublish: true };

  it('offers its owner everything, new shares in the owner region, and no share holder', () => {
    const { places, unpickable } = placesIn(
      { shares: [travel], folders },
      { owner: true, spaceName: 'Family', spaceOpened: true },
    );
    const owned = { max: 'publisher' };
    expect(places).toEqual([
      {
        ...owned,
        folderId: 'recipes',
        path: ['Family', 'Home', 'Recipes'],
        shareId: null,
        newShare: true,
      },
      {
        ...owned,
        folderId: 'soups',
        path: ['Family', 'Home', 'Recipes', 'Soups'],
        shareId: null,
        newShare: true,
      },
      {
        ...owned,
        folderId: 'travel',
        path: ['Family', 'Home', 'Travel'],
        shareId: 's1',
        newShare: false,
      },
    ]);
    // The space and Home hold Travel's share, so they can't become shares.
    expect(unpickable.map((u) => u.folderId)).toEqual([null, 'home']);
  });

  it('offers a member only their shares, at their own access', () => {
    // As a member sees it: the share root has no parent.
    const memberFolders = [
      { id: 'travel', parentId: null, name: 'Travel' },
      { id: 'trips', parentId: 'travel', name: 'Trips' },
    ];
    const { places } = placesIn(
      {
        shares: [{ shareId: 's1', rootId: 'travel', role: 'reader', canPublish: false }],
        folders: memberFolders,
      },
      { owner: false, spaceName: null, spaceOpened: false },
    );
    expect(places).toEqual([
      { folderId: 'travel', path: ['Travel'], max: 'reader', shareId: 's1', newShare: false },
      {
        folderId: 'trips',
        path: ['Travel', 'Trips'],
        max: 'reader',
        shareId: 's1',
        newShare: false,
      },
    ]);
  });
});

describe('picks the person’s own record doesn’t back', () => {
  const grant = (shareId: string, role: 'reader' | 'editor') => ({ spaceId: 'sp', shareId, role });
  const listed = [
    {
      agentId: 'agent-a',
      revokedAt: null,
      grants: [
        grant('kept', 'editor'),
        grant('unlisted', 'reader'),
        // Demoted in the record, but the server still lists it as editor.
        grant('demoted', 'editor'),
        // Editor in the record, reader on the server.
        grant('drafts', 'reader'),
      ],
    },
    // A revoked agent gets nothing anyway.
    {
      agentId: 'agent-gone',
      revokedAt: '2026-10-01T00:00:00.000Z',
      grants: [grant('x', 'reader')],
    },
    // On no record at all.
    { agentId: 'agent-b', revokedAt: null, grants: [grant('y', 'reader')] },
  ];
  const recorded = [
    {
      enrollment: { agent: { id: 'agent-a' } },
      shares: [
        { spaceId: 'sp', shareId: 'kept', drafts: true },
        { spaceId: 'sp', shareId: 'demoted', drafts: false },
        { spaceId: 'sp', shareId: 'drafts', drafts: true },
      ],
    },
  ];

  it('names what the record says, in both directions', () => {
    expect(picksOffRecord(listed, recorded)).toEqual([
      { agentId: 'agent-a', spaceId: 'sp', shareId: 'unlisted', kind: 'unrecorded' },
      {
        agentId: 'agent-a',
        spaceId: 'sp',
        shareId: 'demoted',
        kind: 'role-differs',
        recorded: 'reader',
      },
      {
        agentId: 'agent-a',
        spaceId: 'sp',
        shareId: 'drafts',
        kind: 'role-differs',
        recorded: 'editor',
      },
      { agentId: 'agent-b', spaceId: 'sp', shareId: 'y', kind: 'unrecorded' },
    ]);
    // A pick set back goes to the record's role, never above the person's own.
    expect(recordedAccess('editor', 'publisher')).toBe('editor');
    expect(recordedAccess('editor', 'reader')).toBe('reader');
  });
});

describe('choosing picks before approving', () => {
  const folders = [
    { id: 'home', parentId: null },
    { id: 'kitchen', parentId: 'home' },
    { id: 'soups', parentId: 'kitchen' },
    { id: 'travel', parentId: null },
  ];
  const pick = (
    folderId: string | null,
    { newShare = true, shareId = null as string | null, spaceId = 'sp' } = {},
  ) => ({ spaceId, folderId, shareId, newShare, ancestors: ancestorsOf(folders, folderId) });

  it('keeps the outer of two picks that become shares, whichever came first', () => {
    const space = pick(null);
    const kitchen = pick('kitchen');
    const soups = pick('soups');
    expect(withPick([space], kitchen)).toEqual({
      picks: [space],
      merged: { inner: kitchen, outer: space },
    });
    expect(withPick([soups], kitchen)).toEqual({
      picks: [kitchen],
      merged: { inner: soups, outer: kitchen },
    });
    expect(withPick([kitchen, pick('travel')], space)).toEqual({
      picks: [space],
      merged: { inner: kitchen, outer: space },
    });
  });
});

it('lists every share a revoked agent may hold keys to, the record’s first, each once', () => {
  const share = (shareId: string) => ({ spaceId: 'sp', shareId });
  // The server dropped b's grant, and lists c, which the record doesn't.
  expect(sharesItHeld([share('a'), share('b')], [share('a'), share('c')])).toEqual([
    share('a'),
    share('b'),
    share('c'),
  ]);
  expect(sharesItHeld([], [share('c')])).toEqual([share('c')]);
});
