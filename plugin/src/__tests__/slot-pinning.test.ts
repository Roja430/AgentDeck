import { beforeEach, describe, expect, it } from 'vitest';
import { SlotPinning } from '../slot-pinning.js';

describe('SlotPinning', () => {
  let p: SlotPinning;

  beforeEach(() => { p = new SlotPinning(); });

  it('assigns positions from the top down', () => {
    p.reconcile(['a', 'b', 'c'], 8);
    expect([p.positionOf('a'), p.positionOf('b'), p.positionOf('c')]).toEqual([0, 1, 2]);
  });

  it('leaves a gap when a session ends instead of shifting the others up', () => {
    // This is the whole point of the mode: your hand knows where 'c' is, and a
    // press must not land on a different agent because 'b' finished.
    p.reconcile(['a', 'b', 'c'], 8);
    p.reconcile(['a', 'c'], 8);
    expect(p.positionOf('a')).toBe(0);
    expect(p.positionOf('c')).toBe(2);
    expect(p.sessionAt(1)).toBeUndefined();
  });

  it('reuses the freed position for the next new session', () => {
    p.reconcile(['a', 'b', 'c'], 8);
    p.reconcile(['a', 'c'], 8);
    p.reconcile(['a', 'c', 'd'], 8);
    expect(p.positionOf('d')).toBe(1);
    expect(p.positionOf('c')).toBe(2); // untouched
  });

  it('is insensitive to the order the list arrives in', () => {
    p.reconcile(['a', 'b'], 8);
    p.reconcile(['b', 'a'], 8);
    expect(p.positionOf('a')).toBe(0);
    expect(p.positionOf('b')).toBe(1);
  });

  it('stops assigning once capacity is reached', () => {
    p.reconcile(['a', 'b', 'c'], 2);
    expect(p.positionOf('c')).toBeUndefined();
    expect(p.size()).toBe(2);
  });

  it('releases positions that fall outside a shrunken capacity', () => {
    // A smaller deck was plugged in; a position past its end is unreachable.
    p.reconcile(['a', 'b', 'c', 'd'], 4);
    p.reconcile(['a', 'b', 'c', 'd'], 2);
    expect(p.size()).toBe(2);
    for (const id of ['a', 'b', 'c', 'd']) {
      const pos = p.positionOf(id);
      if (pos !== undefined) expect(pos).toBeLessThan(2);
    }
  });

  it('counts a gap in the extent, because the gap still needs paging past', () => {
    p.reconcile(['a', 'b', 'c'], 8);
    p.reconcile(['c'], 8);
    expect(p.size()).toBe(1);
    expect(p.occupiedExtent()).toBe(3); // positions 0 and 1 are empty but present
  });

  it('reports an empty extent when nothing is running', () => {
    p.reconcile([], 8);
    expect(p.occupiedExtent()).toBe(0);
  });

  it('maps a position back to its session', () => {
    p.reconcile(['a', 'b'], 8);
    expect(p.sessionAt(1)).toBe('b');
    expect(p.sessionAt(5)).toBeUndefined();
  });

  it('drops everything on clear, so switching back to packed leaves no residue', () => {
    p.reconcile(['a', 'b'], 8);
    p.clear();
    expect(p.size()).toBe(0);
    expect(p.occupiedExtent()).toBe(0);
  });
});
