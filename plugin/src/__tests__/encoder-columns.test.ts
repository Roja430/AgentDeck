/**
 * Which slice of the OFFLINE banner each encoder draws.
 *
 * The banner is one 800px design cut into four 200px slices. Every dial used to
 * pass a constant matching its default slot, so moving a dial — the effort dial
 * onto E1, say — printed slice 1 twice and never printed slice 0, which is what
 * the corrupted-looking strip in the field actually was.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  forgetEncoderColumn,
  offlineSliceFor,
  rememberEncoderColumn,
} from '../encoder-registry.js';

const IDS = ['a', 'b', 'c', 'd'];

describe('offline banner slices', () => {
  beforeEach(() => IDS.forEach(forgetEncoderColumn));

  it('follows the column the encoder actually occupies', () => {
    rememberEncoderColumn('a', 2);
    expect(offlineSliceFor('a')).toBe(2);
  });

  it('covers each slice exactly once whatever order the dials are placed in', () => {
    // The user's layout: effort on E1, Claude usage on E2, model+mode on E3,
    // launcher on E4 — none of them in the slot their old constant assumed.
    rememberEncoderColumn('effort', 0);
    rememberEncoderColumn('usage', 1);
    rememberEncoderColumn('agent', 2);
    rememberEncoderColumn('launcher', 3);

    const slices = ['effort', 'usage', 'agent', 'launcher'].map(offlineSliceFor);
    expect([...slices].sort()).toEqual([0, 1, 2, 3]);
    forgetEncoderColumn('effort');
    forgetEncoderColumn('usage');
    forgetEncoderColumn('agent');
    forgetEncoderColumn('launcher');
  });

  it('falls back to the first slice for an encoder it never saw appear', () => {
    // Better a readable left edge than a blank strip.
    expect(offlineSliceFor('never-seen')).toBe(0);
  });

  it('forgets a column when the action goes away', () => {
    rememberEncoderColumn('b', 3);
    forgetEncoderColumn('b');
    expect(offlineSliceFor('b')).toBe(0);
  });

  it('ignores a missing coordinate rather than recording a wrong one', () => {
    // Keys report coordinates as {column,row}; an encoder without them tells us
    // nothing, and storing `undefined` as 0 would claim it sits on the left.
    rememberEncoderColumn('c', undefined);
    expect(offlineSliceFor('c')).toBe(0);
  });
});
