import { describe, expect, it } from 'vitest';
import {
  PermissionMode,
  State,
  type PromptOptionsEvent,
  type SessionInfo,
  type StateUpdateEvent,
} from '@agentdeck/shared';
import { FocusedDetailState } from '../focused-detail-state.js';

const claude: SessionInfo = {
  id: 'claude:enhance-timeline',
  port: 9121,
  projectName: 'enhance-timeline',
  agentType: 'claude-code',
  alive: true,
  state: State.PROCESSING,
};

function state(overrides: Partial<StateUpdateEvent>): StateUpdateEvent {
  return {
    type: 'state_update',
    state: State.PROCESSING,
    permissionMode: PermissionMode.DEFAULT,
    ...overrides,
  };
}

describe('FocusedDetailState', () => {
  it('does not carry an OpenClaw GLM model into a focused Claude session', () => {
    const store = new FocusedDetailState();
    store.prime(claude);

    expect(store.applyState(state({
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      agentType: 'openclaw',
      modelName: 'GLM-5.2 (1M)',
    }), claude)).toBeNull();

    const detail = store.applyState(state({
      sessionId: claude.id,
      focusedSessionId: claude.id,
      agentType: 'claude-code',
      currentTool: 'Edit',
    }), claude);

    expect(detail).toMatchObject({ sessionId: claude.id, tool: 'Edit' });
    expect(detail?.modelName).toBeUndefined();
  });

  it('drops late options from another session and unscoped legacy options', () => {
    const store = new FocusedDetailState();
    store.prime(claude);
    const foreign: PromptOptionsEvent = {
      type: 'prompt_options',
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      promptType: 'multi_select',
      options: [{ index: 0, label: 'Switch to GLM' }],
    };
    const unscoped: PromptOptionsEvent = {
      type: 'prompt_options',
      promptType: 'multi_select',
      options: [{ index: 0, label: 'Run unrelated task' }],
    };

    expect(store.applyOptions(foreign, claude)).toBeNull();
    expect(store.applyOptions(unscoped, claude)).toBeNull();
    expect(store.snapshot?.options).toEqual([]);
  });

  it('accepts options correlated to the selected session', () => {
    const store = new FocusedDetailState();
    store.prime(claude);
    const options: PromptOptionsEvent = {
      type: 'prompt_options',
      sessionId: claude.id,
      focusedSessionId: claude.id,
      promptType: 'yes_no',
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    };

    expect(store.applyOptions(options, claude)).toMatchObject({
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    });
  });

  describe('daemon state events', () => {
    // On focus_session the daemon broadcasts its OWN state — which is
    // DISCONNECTED, since it runs no agent — and stamps the focused session's
    // id onto it. The id check therefore passes, and re-entering a live
    // session's detail view showed DISCONNECTED until the relay connected.
    it('does not apply the daemon state to a focused agent session', () => {
      const store = new FocusedDetailState();
      store.prime(claude);

      expect(store.applyState(state({
        focusedSessionId: claude.id,
        agentType: 'daemon' as never,
        state: State.DISCONNECTED,
      }), claude)).toBeNull();

      expect(store.snapshot?.state).toBe(State.PROCESSING);
    });

    it('still applies a state that came from the session itself', () => {
      const store = new FocusedDetailState();
      store.prime(claude);

      store.applyState(state({
        focusedSessionId: claude.id, agentType: 'daemon' as never, state: State.DISCONNECTED,
      }), claude);

      expect(store.applyState(state({
        focusedSessionId: claude.id, agentType: 'claude-code', state: State.IDLE,
      }), claude)).toMatchObject({ state: State.IDLE });
    });

    it('still applies it when the daemon itself is the focused session', () => {
      const daemonSession: SessionInfo = {
        ...claude, id: 'daemon', agentType: 'daemon' as never, state: State.DISCONNECTED,
      };
      const store = new FocusedDetailState();
      store.prime(daemonSession);

      expect(store.applyState(state({
        focusedSessionId: 'daemon', agentType: 'daemon' as never, state: State.DISCONNECTED,
      }), daemonSession)).toMatchObject({ state: State.DISCONNECTED });
    });
  });
});
