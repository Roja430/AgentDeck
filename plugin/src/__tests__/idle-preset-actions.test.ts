import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@agentdeck/shared';
import { State } from '@agentdeck/shared';
import { SessionSlotManager } from '../session-slot-manager.js';

const SDPLUS = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };
const MANAGED = '9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

function managedIdle(): SessionSlotManager {
  const mgr = new SessionSlotManager();
  mgr.updateSessions([{
    id: MANAGED,
    port: 9121,
    projectName: 'demo',
    alive: true,
    state: 'idle',
    agentType: 'claude-code',
    controlMode: 'managed',
  } as SessionInfo]);
  mgr.enterDetailView(MANAGED);
  mgr.updateDetailState(State.IDLE, []);
  return mgr;
}

function slotOfPreset(mgr: SessionSlotManager, label: string): number | undefined {
  for (let s = 0; s < SDPLUS.keyCount; s++) {
    const c = mgr.getSlotConfig(s, SDPLUS);
    if (c.type === 'preset' && c.preset?.label === label) return s;
  }
  return undefined;
}

describe('Claude Code idle quick actions', () => {
  it('routes REVIEW to the on-demand eval instead of doing nothing', () => {
    // REVIEW carries a localAction and no prompt. The preset builder dropped
    // localAction, so the key resolved to 'none' — it looked live and was dead.
    const mgr = managedIdle();
    const slot = slotOfPreset(mgr, 'REVIEW');
    expect(slot).toBeDefined();
    expect(mgr.handleSlotPress(slot!, SDPLUS).action).toBe('review-run');
  });

  it('still sends the prompt-backed actions as prompts', () => {
    const mgr = managedIdle();
    for (const [label, text] of [['GO ON', 'go on'], ['COMMIT', '/commit'], ['CLEAR', '/clear']] as const) {
      const slot = slotOfPreset(mgr, label);
      expect(slot, label).toBeDefined();
      const res = mgr.handleSlotPress(slot!, SDPLUS);
      expect(res.action, label).toBe('send-prompt');
      expect(res.promptText, label).toBe(text);
    }
  });
});
