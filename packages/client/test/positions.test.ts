import { describe, expect, it } from 'vite-plus/test';
import { isPosition } from '@wikistow/contracts';
import {
  orderOperations,
  inTreeOrder,
  treeInOrder,
  positionBetween,
  positionsBetween,
  positionsFor,
  type OrderedNode,
} from '../src/index.ts';

const node = (
  id: string,
  position: string | null,
  kind: 'folder' | 'page' = 'page',
  label = id,
): OrderedNode => ({ id, kind, position, label });

// Apply writes, then list as every list does.
function listed(nodes: OrderedNode[], writes: ReturnType<typeof positionsFor>) {
  const by = new Map(writes.map((w) => [w.nodeId, w.position]));
  return inTreeOrder(
    nodes.map((n) => (by.has(n.id) ? { ...n, position: by.get(n.id) ?? null } : n)),
  ).map((n) => n.id);
}

describe('positions', () => {
  it('fits a position between any two, and at either end', () => {
    expect(positionBetween(null, null)).toBe('a0');
    const first = positionBetween(null, null);
    const after = positionBetween(first, null);
    const before = positionBetween(null, first);
    const middle = positionBetween(first, after);
    expect([after, before, middle].every(isPosition)).toBe(true);
    expect(before < first && first < middle && middle < after).toBe(true);
  });

  it('keeps fitting between two that are ever closer, and appending stays short', () => {
    let low = positionBetween(null, null);
    const high = positionBetween(low, null);
    for (let i = 0; i < 200; i++) {
      const next = positionBetween(low, high);
      expect(next > low && next < high).toBe(true);
      low = next;
    }
    let end = positionBetween(null, null);
    for (let i = 0; i < 5000; i++) end = positionBetween(end, null);
    expect(end.length).toBeLessThan(6);
  });

  it('gives many in order', () => {
    const keys = positionsBetween('a0', 'a1', 50);
    expect(keys).toHaveLength(50);
    expect(keys.every((key, i) => i === 0 || (keys[i - 1] ?? '') < key)).toBe(true);
    expect(keys[0]! > 'a0' && keys.at(-1)! < 'a1').toBe(true);
  });

  it('refuses keys out of order and ones that aren’t positions', () => {
    expect(() => positionBetween('a1', 'a0')).toThrow();
    expect(() => positionBetween('a1', 'a1')).toThrow();
    expect(isPosition('a10')).toBe(false); // a fraction ending in 0
    expect(isPosition('b0')).toBe(false); // too short for its head
    expect(isPosition('a!')).toBe(false);
    expect(isPosition('')).toBe(false);
    expect(isPosition('a0V')).toBe(true);
  });
});

describe('inTreeOrder', () => {
  it('lists by name, folders first, when nothing has a position', () => {
    const nodes = [
      node('b', null),
      node('Z', null, 'folder'),
      node('a', null),
      node('Y', null, 'folder'),
    ];
    expect(inTreeOrder(nodes).map((n) => n.id)).toEqual(['Y', 'Z', 'a', 'b']);
  });

  it('lists positions first, mixing folders and pages, then the rest by name', () => {
    const nodes = [
      node('page', 'a0'),
      node('folder', 'a1', 'folder'),
      node('late', null),
      node('early', null),
      node('other', null, 'folder'),
    ];
    expect(inTreeOrder(nodes).map((n) => n.id)).toEqual([
      'page',
      'folder',
      'other',
      'early',
      'late',
    ]);
  });

  it('breaks a tie between equal positions by ID', () => {
    expect(inTreeOrder([node('b', 'a0'), node('a', 'a0')]).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('positionsFor', () => {
  it('orders a folder sorted by name by giving everything in it a position', () => {
    const nodes = [node('a', null), node('b', null), node('c', null), node('d', null)];
    // d dropped between a and b.
    const order = [nodes[0]!, nodes[3]!, nodes[1]!, nodes[2]!];
    const writes = positionsFor(order, 'd');
    expect(writes.map((w) => w.nodeId)).toEqual(['a', 'd', 'b', 'c']);
    expect(listed(nodes, writes)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('writes only the item moved where its neighbours have positions', () => {
    const nodes = [node('a', 'a0'), node('b', 'a1'), node('c', 'a2')];
    const writes = positionsFor([nodes[2]!, nodes[0]!, nodes[1]!], 'c');
    expect(writes.map((w) => w.nodeId)).toEqual(['c']);
    expect(listed(nodes, writes)).toEqual(['c', 'a', 'b']);
  });

  it('gives those listed by name after the ordered ones positions too', () => {
    const nodes = [node('x', 'a0'), node('a', null), node('b', null), node('c', null)];
    const writes = positionsFor([nodes[0]!, nodes[1]!, nodes[3]!, nodes[2]!], 'c');
    expect(writes.map((w) => w.nodeId)).toEqual(['a', 'c', 'b']);
    expect(listed(nodes, writes)).toEqual(['x', 'a', 'c', 'b']);
  });

  it('gives equal positions new keys', () => {
    const nodes = [node('a', 'a0'), node('b', 'a0'), node('c', 'a1')];
    const writes = positionsFor([nodes[2]!, nodes[0]!, nodes[1]!], 'c');
    expect(listed(nodes, writes)).toEqual(['c', 'a', 'b']);
  });

  it('places an item arriving from elsewhere, which is in no position yet', () => {
    const nodes = [node('a', 'a0'), node('b', 'a1')];
    const arriving = node('new', null);
    const writes = positionsFor([nodes[0]!, arriving, nodes[1]!], 'new');
    expect(writes.map((w) => w.nodeId)).toEqual(['new']);
    expect(listed([...nodes, arriving], writes)).toEqual(['a', 'new', 'b']);
  });

  it('writes the whole run afresh once keys grow too long', () => {
    let nodes = [node('a', 'a0'), node('b', 'a1'), node('c', null)];
    // Put c between a and b, then the newest between a and it, again and again.
    for (let i = 0; i < 120; i++) {
      const [a, ...rest] = inTreeOrder(nodes);
      const moved = rest.at(-1)!;
      const order = [a!, moved, ...rest.slice(0, -1)];
      const writes = positionsFor(order, moved.id);
      const by = new Map(writes.map((w) => [w.nodeId, w.position]));
      nodes = nodes.map((n) => (by.has(n.id) ? { ...n, position: by.get(n.id) ?? null } : n));
      expect(inTreeOrder(nodes).map((n) => n.id)).toEqual(order.map((n) => n.id));
      expect(nodes.every((n) => n.position === null || n.position.length <= 80)).toBe(true);
    }
  });
});

describe('placing', () => {
  it('keeps the key of the item dropped when it stays the same', () => {
    const { own } = orderOperations.placing(
      [
        { id: 'a', position: 'a0' },
        { id: 'b', position: 'a0' },
        { id: 'x', position: 'a1' },
      ],
      'x',
      'b',
    );
    expect(own.position).not.toBeNull();
  });
});

describe('treeInOrder', () => {
  it('lists what the top doesn’t reach after the rest', () => {
    const tree = {
      folders: [{ id: 'f', parentId: null, position: null }],
      pages: [
        { id: 'p', parentId: 'f', position: null },
        { id: 'lost', parentId: 'gone', position: null },
      ],
    };
    const ids = treeInOrder(tree, { folder: (f) => f.id, page: (p) => p.id }).map((c) => c.node.id);
    expect(ids).toEqual(['f', 'p', 'lost']);
  });
});
