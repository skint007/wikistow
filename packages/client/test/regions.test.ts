import { describe, expect, it } from 'vite-plus/test';
import {
  OWNER_REGION,
  regionInTree,
  requireRegion,
  ShareId,
  SpaceId,
  writeRegion,
  type Region,
} from '../src/index.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const spaceId = SpaceId.parse('space');
const share = (id: string): Region => ({ kind: 'share', spaceId, shareId: ShareId.parse(id) });

// The server's tree: notes / recipes / soup.
const parents: Record<string, string | null> = {
  notes: null,
  recipes: 'notes',
  soup: 'recipes',
};
const parentOf = (nodeId: string) => parents[nodeId];
const inTree = (
  subject: Parameters<typeof regionInTree>[0]['subject'],
  shares: { shareId: string; rootId: string | null }[],
) =>
  regionInTree({
    subject,
    parentOf,
    shares: shares.map((s) => ({ spaceId, shareId: ShareId.parse(s.shareId), rootId: s.rootId })),
  });
const node = (nodeId: string) => ({ kind: 'node' as const, nodeId });

describe('regions in the server’s tree (section 6.1)', () => {
  it('put a node in the share rooted at it or its nearest ancestor that is a root', () => {
    const shares = [{ shareId: 'r', rootId: 'recipes' }];
    expect(inTree(node('soup'), shares)).toEqual(share('r'));
    expect(inTree(node('recipes'), shares)).toEqual(share('r'));
    // The folder above a share root, and the space's name, stay with the owners.
    expect(inTree(node('notes'), shares)).toEqual(OWNER_REGION);
    expect(inTree({ kind: 'space' }, shares)).toEqual(OWNER_REGION);
  });
});

describe('the region of a write (sections 6.1 and 6.8)', () => {
  it('refuse an owner’s next edit when the server relabels the tree into a share', () => {
    // Soup was opened through the owners' envelopes, but the server now
    // claims its folder is a share root, or the whole space is shared.
    const write = writeRegion({ kind: 'based-on', basedOn: OWNER_REGION });
    for (const relabelled of [
      [{ shareId: 'r', rootId: 'recipes' }],
      [{ shareId: 'all', rootId: null }],
    ]) {
      expect(() => requireRegion({ write, tree: inTree(node('soup'), relabelled) })).toThrow(
        code('region-mismatch'),
      );
    }
    expect(() => requireRegion({ write, tree: inTree(node('soup'), []) })).not.toThrow();
    // Nor may a new folder go into a share its parent's name isn't in.
    const newFolder = writeRegion({ kind: 'new-node', parentName: OWNER_REGION });
    const tree = inTree(node('recipes'), [{ shareId: 'r', rootId: 'recipes' }]);
    expect(() => requireRegion({ write: newFolder, tree })).toThrow(code('region-mismatch'));
  });
});
