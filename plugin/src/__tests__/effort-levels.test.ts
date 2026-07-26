/**
 * Reasoning-effort roll.
 *
 * The dial stages a level locally and applies it on press, so the only thing
 * worth pinning here is that the cursor cannot land somewhere the user did not
 * aim for — an overshoot that wrapped would quietly change how the agent thinks.
 */
import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, indexOfLevel, stepLevel } from '../effort-levels.js';

describe('effort levels', () => {
  it('offers auto plus the five CLI levels, cheapest first', () => {
    expect([...EFFORT_LEVELS]).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('locates a reported level, case-insensitively', () => {
    expect(indexOfLevel('high')).toBe(3);
    expect(indexOfLevel('HIGH')).toBe(3);
  });

  it('falls back to auto for an unknown or absent level', () => {
    // `ultracode` is real but model-dependent, so it can arrive without being
    // in the roll — that must not throw or land on an arbitrary index.
    expect(indexOfLevel('ultracode')).toBe(0);
    expect(indexOfLevel(undefined)).toBe(0);
  });

  it('clamps at both ends instead of wrapping', () => {
    expect(stepLevel(0, -1)).toBe(0);
    expect(stepLevel(EFFORT_LEVELS.length - 1, 1)).toBe(EFFORT_LEVELS.length - 1);
  });

  it('moves one step per turn in each direction', () => {
    expect(stepLevel(2, 1)).toBe(3);
    expect(stepLevel(2, -1)).toBe(1);
    // Stream Deck reports multi-detent turns as a tick count; one step per
    // event keeps a fast flick from skipping past the level being read.
    expect(stepLevel(2, 5)).toBe(3);
  });
});
