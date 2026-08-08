import {
  State,
  type PromptOption,
  type PromptOptionsEvent,
  type SessionInfo,
  type StateUpdateEvent,
} from '@agentdeck/shared';

/**
 * How long a freshly raised prompt is protected from a contradicting list row.
 *
 * `sessions_list` is rebuilt at broadcast time, so a row is normally current —
 * but it can be assembled a moment before the push that raised the prompt lands,
 * and the daemon's liveness grace lets a row ride older state still. Five
 * seconds covers that ordering window while leaving the strip stale for a
 * fraction of the time it used to be.
 */
const STALE_ROW_GRACE_MS = 5_000;

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
  /**
   * When the current snapshot's options were last set, so a polled row can be
   * told apart from a fresh live event. See `releasePromptFromSession`.
   */
  private optionsSetAt = 0;

  get snapshot(): FocusedDetailSnapshot | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
    this.optionsSetAt = 0;
  }

  /** Stamp the snapshot's age, so `optionsSetAt` cannot drift from `options`. */
  private commit(next: FocusedDetailSnapshot, now = Date.now()): FocusedDetailSnapshot {
    this.current = next;
    this.optionsSetAt = next.options.length > 0 ? now : 0;
    return next;
  }

  prime(session: SessionInfo): FocusedDetailSnapshot {
    return this.commit({
      sessionId: session.id,
      state: stateFromSession(session),
      options: session.options ?? [],
      tool: session.currentTool ?? session.currentTask,
      question: session.question,
      modelName: session.modelName,
      effortLevel: session.effortLevel,
    });
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

    return this.commit({ ...current, state, options, question: session.question });
  }

  /**
   * Drop the prompt when the session's list row says it is no longer waiting.
   *
   * The mirror of `adoptPromptFromSession`, and just as necessary. The encoder
   * takeover only ever learns about the world through `renderFocusedDetail`, so
   * a prompt that is cleared without a `state_update` reaching this client — the
   * focus relay reconnecting at the wrong moment is enough — leaves the four
   * LCDs offering answers to a question that is gone, and a press sends one.
   * Nothing else was going to notice: the list row is the only other channel,
   * and it was read one-way.
   *
   * The one-way rule existed for a reason, so this does not simply reverse it.
   * A polled row can be older than the live event that raised the prompt, and
   * letting a stale row win would make the deck flicker — clear on the old row,
   * re-adopt on the next. Hence the grace period: a row may only contradict a
   * prompt that has been on screen longer than the list's own lag.
   */
  releasePromptFromSession(session: SessionInfo, now = Date.now()): FocusedDetailSnapshot | null {
    const current = this.current;
    if (!current || current.sessionId !== session.id) return null;
    if (current.options.length === 0) return null;
    if (now - this.optionsSetAt < STALE_ROW_GRACE_MS) return null;
    // The row has to agree on both counts. A row that still carries options is
    // reporting the same prompt, whatever its state field rounds to.
    if ((session.options ?? []).length > 0) return null;
    const state = stateFromSession(session);
    if (state === State.AWAITING_PERMISSION
      || state === State.AWAITING_OPTION
      || state === State.AWAITING_DIFF) return null;

    return this.commit({ ...current, state, options: [], question: undefined }, now);
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

    return this.commit({
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
    });
  }

  applyOptions(ev: PromptOptionsEvent, focused: SessionInfo): FocusedDetailSnapshot | null {
    // prompt_options is backward compatibility only. It is actionable in a
    // detail view solely when the daemon correlated it to the selected session.
    if (eventSessionId(ev) !== focused.id) return null;
    const base = this.current?.sessionId === focused.id
      ? this.current
      : this.prime(focused);
    return this.commit({
      ...base,
      options: ev.options,
      question: ev.question,
    });
  }
}
