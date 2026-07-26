import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionInfo } from '@agentdeck/shared';
import { resetDeckSettingsCache } from '@agentdeck/shared';
import { SessionSlotManager } from '../session-slot-manager.js';

/** Stream Deck+ keypad. */
const SDPLUS = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };

function session(id: string): SessionInfo {
  return {
    id,
    port: 9121,
    projectName: id,
    alive: true,
    state: 'idle',
    agentType: 'claude-code',
    startedAt: '2026-07-26T00:00:00.000Z',
  } as SessionInfo;
}

/** Which session id sits on each key, or null for an empty key. */
function layoutOf(mgr: SessionSlotManager): (string | null)[] {
  return Array.from({ length: SDPLUS.keyCount }, (_, slot) => {
    const c = mgr.getSlotConfig(slot, SDPLUS);
    return c.type === 'session' ? (c.session?.id ?? null) : null;
  });
}

describe('SessionSlotManager slot pinning', () => {
  let dir: string;
  const original = process.env.AGENTDECK_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-deck-settings-'));
    process.env.AGENTDECK_DATA_DIR = dir;
    resetDeckSettingsCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
    resetDeckSettingsCache();
  });

  function setPinned(pinnedSlots: boolean): void {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ deck: { pinnedSlots } }), 'utf-8');
    resetDeckSettingsCache();
  }

  it('packs by default, so ending a session shifts the rest up', () => {
    // Unchanged behaviour — nobody's keypad rearranges without opting in.
    const mgr = new SessionSlotManager();
    mgr.updateSessions([session('a'), session('b'), session('c')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', 'b', 'c']);

    mgr.updateSessions([session('a'), session('c')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', 'c', null]);
  });

  it('holds each session on its key when pinning is on', () => {
    setPinned(true);
    const mgr = new SessionSlotManager();
    mgr.updateSessions([session('a'), session('b'), session('c')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', 'b', 'c']);

    // 'b' ends. 'c' must not move onto key 1.
    mgr.updateSessions([session('a'), session('c')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', null, 'c']);
  });

  it('gives a new session the freed key rather than appending', () => {
    setPinned(true);
    const mgr = new SessionSlotManager();
    mgr.updateSessions([session('a'), session('b'), session('c')]);
    mgr.updateSessions([session('a'), session('c')]);
    mgr.updateSessions([session('a'), session('c'), session('d')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', 'd', 'c']);
  });

  it('keeps keys stable when the sort order changes', () => {
    setPinned(true);
    const mgr = new SessionSlotManager();
    mgr.updateSessions([session('a'), session('b')]);
    const before = layoutOf(mgr);
    mgr.updateSessions([session('b'), session('a')]);
    expect(layoutOf(mgr)).toEqual(before);
  });

  it('drops the pinning when the setting is turned back off', () => {
    setPinned(true);
    const mgr = new SessionSlotManager();
    mgr.updateSessions([session('a'), session('b'), session('c')]);
    mgr.updateSessions([session('a'), session('c')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', null, 'c']);

    setPinned(false);
    mgr.updateSessions([session('a'), session('c')]);
    expect(layoutOf(mgr).slice(0, 3)).toEqual(['a', 'c', null]);
  });

  it('pressing a pinned key still resolves to the session on it', () => {
    // The gap must not shift what a press means — that is the failure the
    // whole mode exists to prevent.
    setPinned(true);
    const mgr = new SessionSlotManager();
    mgr.updateSessions([session('a'), session('b'), session('c')]);
    mgr.updateSessions([session('a'), session('c')]);
    expect(mgr.handleSlotPress(2, SDPLUS).sessionId).toBe('c');
    expect(mgr.handleSlotPress(1, SDPLUS).action).not.toBe('enter-detail');
  });
});
