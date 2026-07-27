/**
 * AWAITING encoder takeover — when it may claim the dials, and where the
 * cursor points when it does.
 *
 * A press here answers a permission prompt, so the two failure modes that
 * matter are answering the wrong option and answering a session that has no
 * response channel at all.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { State, type PromptOption, type SessionInfo } from '@agentdeck/shared';
import {
  EncoderTakeoverState,
  isAnswerable,
  isAwaitingState,
  soleAwaitingSession,
} from '../encoder-takeover-state.js';

const opts = (...labels: string[]): PromptOption[] =>
  labels.map((label, index) => ({ index, label }));

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1', port: 9121, projectName: 'demo', agentType: 'claude-code',
  alive: true, controlMode: 'managed', ...over,
} as SessionInfo);

describe('isAwaitingState', () => {
  it('covers every state that holds for a human', () => {
    expect(isAwaitingState(State.AWAITING_PERMISSION)).toBe(true);
    expect(isAwaitingState(State.AWAITING_OPTION)).toBe(true);
    expect(isAwaitingState(State.AWAITING_DIFF)).toBe(true);
    expect(isAwaitingState(State.IDLE)).toBe(false);
    expect(isAwaitingState(State.PROCESSING)).toBe(false);
    expect(isAwaitingState(undefined)).toBe(false);
  });
});

describe('isAnswerable', () => {
  it('accepts a managed session, which owns a PTY', () => {
    expect(isAnswerable(session())).toBe(true);
  });

  it('accepts an observed session only when the daemon held a gate', () => {
    expect(isAnswerable(session({ controlMode: 'observed', requestId: 'r1' } as Partial<SessionInfo>))).toBe(true);
  });

  it('refuses an observed session with nothing to answer through', () => {
    // Its AskUserQuestion options are mirrored for reading; a press would be
    // silently dropped, which is worse than a dial that says it cannot answer.
    expect(isAnswerable(session({ controlMode: 'observed' }))).toBe(false);
  });

  it('refuses when there is no session at all', () => {
    expect(isAnswerable(undefined)).toBe(false);
  });
});

describe('EncoderTakeoverState', () => {
  let s: EncoderTakeoverState;
  beforeEach(() => { s = new EncoderTakeoverState(); });

  const awaiting = (over = {}) => ({
    sessionId: 's1',
    state: State.AWAITING_OPTION,
    options: opts('Yes', 'No', 'Always'),
    question: 'Allow Edit?',
    session: session(),
    ...over,
  });

  it('claims the dials only while awaiting with options to show', () => {
    expect(s.sync(awaiting())).toBe(true);
    expect(s.isActive()).toBe(true);

    expect(s.sync(awaiting({ state: State.IDLE }))).toBe(true);
    expect(s.isActive()).toBe(false);
  });

  it('does not claim them for an awaiting state carrying no options', () => {
    // Nothing to choose from — the keypad shows a status card and the dials
    // stay useful.
    s.sync(awaiting({ options: [] }));
    expect(s.isActive()).toBe(false);
  });

  it('reports the flip only on the transition', () => {
    expect(s.sync(awaiting())).toBe(true);
    expect(s.sync(awaiting())).toBe(false);
  });

  it('clamps at both ends instead of wrapping', () => {
    // Wrapping would turn one overshoot on a two-option prompt into the
    // opposite answer.
    s.sync(awaiting());
    s.rotate(-1);
    expect(s.getCursor()).toBe(0);
    s.rotate(1); s.rotate(1); s.rotate(1); s.rotate(1);
    expect(s.getCursor()).toBe(2);
  });

  it('keeps the cursor while the same prompt is re-sent', () => {
    s.sync(awaiting());
    s.rotate(1);
    s.sync(awaiting());
    expect(s.getCursor()).toBe(1);
  });

  it('resets the cursor when the question changes', () => {
    s.sync(awaiting());
    s.rotate(1);
    s.sync(awaiting({ question: 'Allow Bash?' }));
    expect(s.getCursor()).toBe(0);
  });

  it('resets the cursor when the answers change under the same question', () => {
    s.sync(awaiting());
    s.rotate(1);
    s.sync(awaiting({ options: opts('Yes', 'Never') }));
    expect(s.getCursor()).toBe(0);
  });

  it('pulls the cursor back inside a shorter option list', () => {
    s.sync(awaiting());
    s.rotate(1); s.rotate(1);
    // Same prompt key would keep index 2; a shorter list must still be safe.
    s.sync({ ...awaiting(), options: opts('Yes', 'No', 'Always').slice(0, 3) });
    expect(s.current()).toBeDefined();
    expect(s.getCursor()).toBeLessThan(s.getOptions().length);
  });

  it('marks an unanswerable session so the dials can refuse the press', () => {
    s.sync(awaiting({ session: session({ controlMode: 'observed' }) }));
    expect(s.isActive()).toBe(true);
    expect(s.isAnswerable()).toBe(false);
  });
});

describe('soleAwaitingSession', () => {
  const s = (id: string, state?: string) => ({ ...session({ id }), state } as SessionInfo);

  it('names the session to auto-focus when only one is waiting', () => {
    expect(soleAwaitingSession([s('a', 'idle'), s('b', State.AWAITING_OPTION)])?.id).toBe('b');
  });

  it('names nobody when two are waiting', () => {
    // Focusing one would hand the dials to a prompt the user did not pick.
    expect(soleAwaitingSession([s('a', State.AWAITING_OPTION), s('b', State.AWAITING_PERMISSION)]))
      .toBeUndefined();
  });

  it('names nobody when none are waiting', () => {
    expect(soleAwaitingSession([s('a', 'idle')])).toBeUndefined();
    expect(soleAwaitingSession([])).toBeUndefined();
  });
});
