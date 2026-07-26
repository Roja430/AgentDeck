import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@agentdeck/shared';
import { State } from '@agentdeck/shared';
import { SessionSlotManager, canForkSession } from '../session-slot-manager.js';

const SDPLUS = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    port: 0,
    projectName: 'demo',
    alive: true,
    state: 'idle',
    agentType: 'claude-code',
    controlMode: 'observed',
    ...over,
  } as SessionInfo;
}

const OBSERVED = 'observed:claude:3f2b1c8a-9d4e-4f10-8a7b-1c2d3e4f5a6b';
const MANAGED = '9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

/** Labels of the preset keys in the idle detail view. */
function presetLabels(mgr: SessionSlotManager): string[] {
  const labels: string[] = [];
  for (let slot = 0; slot < SDPLUS.keyCount; slot++) {
    const c = mgr.getSlotConfig(slot, SDPLUS);
    if (c.type === 'preset' && c.preset) labels.push(c.preset.label);
  }
  return labels;
}

function idleDetail(id: string): SessionSlotManager {
  const mgr = new SessionSlotManager();
  mgr.updateSessions([session(id)]);
  mgr.enterDetailView(id);
  mgr.updateDetailState(State.IDLE, []);
  return mgr;
}

describe('canForkSession', () => {
  it('accepts observed Claude sessions, whose id embeds the Claude session id', () => {
    expect(canForkSession(session(OBSERVED))).toBe(true);
  });

  it('rejects managed sessions, whose id resumes nothing', () => {
    expect(canForkSession(session(MANAGED, { controlMode: 'managed' }))).toBe(false);
  });

  it('rejects an absent session', () => {
    expect(canForkSession(undefined)).toBe(false);
  });
});

describe('FORK preset', () => {
  it('appears for an observed session', () => {
    expect(presetLabels(idleDetail(OBSERVED))).toContain('FORK');
  });

  it('is absent for a managed session rather than offered and failing', () => {
    expect(presetLabels(idleDetail(MANAGED))).not.toContain('FORK');
  });

  it('sits beside REVIEW, the other action an observed session can take', () => {
    // An observed session has no prompt-delivery path, so GO ON / COMMIT /
    // CLEAR are absent by design. REVIEW and FORK both act from outside it.
    expect(presetLabels(idleDetail(OBSERVED))).toEqual(['REVIEW', 'FORK']);
  });

  it('does not displace the OBSERVED status card', () => {
    const mgr = idleDetail(OBSERVED);
    const labels: string[] = [];
    for (let s = 0; s < SDPLUS.keyCount; s++) {
      const c = mgr.getSlotConfig(s, SDPLUS);
      if (c.type === 'status') labels.push(c.label ?? '');
    }
    expect(labels).toContain('OBSERVED');
  });

  it('resolves a press to the fork action', () => {
    const mgr = idleDetail(OBSERVED);
    const forkSlot = [0, 1, 2, 3, 4, 5, 6, 7].find((s) => {
      const c = mgr.getSlotConfig(s, SDPLUS);
      return c.type === 'preset' && c.preset?.label === 'FORK';
    })!;
    expect(mgr.handleSlotPress(forkSlot, SDPLUS).action).toBe('fork-session');
  });
});

