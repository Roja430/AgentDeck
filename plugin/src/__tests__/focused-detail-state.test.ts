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

/**
 * A prompt raised before the deck focused the session sends no state_update —
 * the relay forwards events, and a session parked at a prompt emits none. The
 * sessions_list row is the only place it exists, so the snapshot has to be able
 * to take it from there or the options never arrive at all.
 */
describe('FocusedDetailState.adoptPromptFromSession', () => {
  const awaiting: SessionInfo = {
    ...claude,
    state: State.AWAITING_PERMISSION,
    question: 'Do you want to overwrite test.txt?',
    options: [
      { index: 0, label: 'Yes' },
      { index: 1, label: 'No' },
    ],
  };

  it('fills in a prompt the live snapshot never heard about', () => {
    const store = new FocusedDetailState();
    store.prime(claude);

    const next = store.adoptPromptFromSession(awaiting);
    expect(next?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(next?.question).toBe('Do you want to overwrite test.txt?');
    expect(next?.state).toBe(State.AWAITING_PERMISSION);
  });

  it('leaves options the snapshot already has alone', () => {
    // The row is polled, so it is always at least as old as the live snapshot.
    // Letting it replace live options would flicker between the two.
    const store = new FocusedDetailState();
    store.prime(claude);
    store.applyState(state({
      sessionId: claude.id,
      state: State.AWAITING_OPTION,
      options: [{ index: 0, label: 'live' }],
      question: 'live question',
    }), claude);

    expect(store.adoptPromptFromSession(awaiting)).toBeNull();
    expect(store.snapshot?.options.map((o) => o.label)).toEqual(['live']);
    expect(store.snapshot?.question).toBe('live question');
  });

  it('never erases a prompt just because the row has not caught up', () => {
    const store = new FocusedDetailState();
    store.prime(awaiting);
    expect(store.adoptPromptFromSession({ ...claude, options: [] })).toBeNull();
    expect(store.snapshot?.options).toHaveLength(2);
  });

  it('ignores a row for a different session', () => {
    const store = new FocusedDetailState();
    store.prime(claude);
    expect(store.adoptPromptFromSession({ ...awaiting, id: 'someone-else' })).toBeNull();
  });

  it('ignores a row that carries options without waiting for an answer', () => {
    // Stale options on a working session would put the dials up mid-turn.
    const store = new FocusedDetailState();
    store.prime(claude);
    expect(store.adoptPromptFromSession({ ...awaiting, state: State.PROCESSING })).toBeNull();
  });

  it('does nothing before anything has been primed', () => {
    expect(new FocusedDetailState().adoptPromptFromSession(awaiting)).toBeNull();
  });
});
