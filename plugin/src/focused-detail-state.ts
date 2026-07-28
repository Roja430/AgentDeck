import {
  State,
  type PromptOption,
  type PromptOptionsEvent,
  type SessionInfo,
  type StateUpdateEvent,
} from '@agentdeck/shared';

/** Session-owned state used exclusively by the keypad detail view. */
export interface FocusedDetailSnapshot {
  sessionId: string;
  state: State;
  options: PromptOption[];
  tool?: string;
  toolInput?: string;
  question?: string;
  modelName?: string;
  mode?: string;
  effortLevel?: string;
  suggestedPrompt?: string;
}

function stateFromSession(session: SessionInfo): State {
  const state = session.state;
  if (
    state === State.IDLE
    || state === State.PROCESSING
    || state === State.AWAITING_PERMISSION
    || state === State.AWAITING_OPTION
    || state === State.AWAITING_DIFF
    || state === State.DISCONNECTED
  ) {
    return state;
  }
  return session.alive ? State.IDLE : State.DISCONNECTED;
}

/** The daemon reports itself with an agentType the shared union does not list. */
function isDaemonAgent(agentType: unknown): boolean {
  return agentType === 'daemon';
}

/** Prefer an explicit user focus, then the event's source session. */
function eventSessionId(ev: { sessionId?: string; focusedSessionId?: string }): string | undefined {
  return ev.focusedSessionId || ev.sessionId || undefined;
}

/**
 * Keeps detail rendering isolated from plugin-global state. A state_update is a
 * replacement snapshot, not a partial merge: an omitted model/tool/question is
 * unknown for this session and must never inherit another agent's value.
 */
export class FocusedDetailState {
  private current: FocusedDetailSnapshot | null = null;

  get snapshot(): FocusedDetailSnapshot | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
  }

  prime(session: SessionInfo): FocusedDetailSnapshot {
    this.current = {
      sessionId: session.id,
      state: stateFromSession(session),
      options: session.options ?? [],
      tool: session.currentTool ?? session.currentTask,
      question: session.question,
      modelName: session.modelName,
      effortLevel: session.effortLevel,
    };
    return this.current;
  }

  /**
   * Take a prompt off the session's list row when this snapshot has none.
   *
   * A prompt that appeared *before* this client focused the session produces no
   * `state_update` — the relay forwards events, and a session parked at a
   * prompt emits none — so the list row is the only place it exists. Without
   * this the options never arrive and nothing recovers them.
   *
   * Deliberately one-way: it fills a gap, never overwrites. A polled row is
   * always at least as old as the live snapshot, so letting it erase or replace
   * options would make the deck flicker between the two.
   */
  adoptPromptFromSession(session: SessionInfo): FocusedDetailSnapshot | null {
    const current = this.current;
    if (!current || current.sessionId !== session.id) return null;
    if (current.options.length > 0) return null;
    const options = session.options ?? [];
    if (options.length === 0) return null;
    const state = stateFromSession(session);
    if (state !== State.AWAITING_PERMISSION
      && state !== State.AWAITING_OPTION
      && state !== State.AWAITING_DIFF) return null;

    this.current = { ...current, state, options, question: session.question };
    return this.current;
  }

  applyState(ev: StateUpdateEvent, focused: SessionInfo): FocusedDetailSnapshot | null {
    const sourceId = eventSessionId(ev);
    const legacyOpenClawMatch = !sourceId
      && focused.agentType === 'openclaw'
      && ev.agentType === 'openclaw';
    if (sourceId !== focused.id && !legacyOpenClawMatch) return null;
    // The daemon stamps the focused session's id onto its OWN state event, so
    // the id check above cannot tell the two apart — only agentType can. It
    // emits one on every focus_session, before the relay to that session has
    // opened, and its own state is DISCONNECTED because the daemon runs no
    // agent. Applying it painted DISCONNECTED over a healthy session for as
    // long as the relay took to connect.
    // `daemon` is outside the declared AgentType union — the daemon casts it on
    // the way out — so this has to compare as a plain string.
    if (isDaemonAgent(ev.agentType) && !isDaemonAgent(focused.agentType)) return null;

    this.current = {
      sessionId: focused.id,
      state: ev.state,
      options: ev.options ?? [],
      tool: ev.currentTool,
      toolInput: ev.toolInput,
      question: ev.question,
      // SessionInfo is the only safe fallback. Never retain the preceding
      // global model (the GLM→Claude contamination reproduced in device logs).
      modelName: ev.modelName ?? focused.modelName,
      mode: ev.permissionMode,
      effortLevel: ev.effortLevel ?? focused.effortLevel,
      suggestedPrompt: ev.state === State.IDLE ? ev.suggestedPrompt : undefined,
    };
    return this.current;
  }

  applyOptions(ev: PromptOptionsEvent, focused: SessionInfo): FocusedDetailSnapshot | null {
    // prompt_options is backward compatibility only. It is actionable in a
    // detail view solely when the daemon correlated it to the selected session.
    if (eventSessionId(ev) !== focused.id) return null;
    const base = this.current?.sessionId === focused.id
      ? this.current
      : this.prime(focused);
    this.current = {
      ...base,
      options: ev.options,
      question: ev.question,
    };
    return this.current;
  }
}
