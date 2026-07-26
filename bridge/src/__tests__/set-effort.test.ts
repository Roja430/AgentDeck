import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';

/**
 * The effort dial drives Claude Code's `/model` picker with raw keystrokes, so
 * the exact bytes and their ordering are the contract. Getting them wrong types
 * junk into a live session rather than failing loudly.
 */
describe('set_effort keystrokes', () => {
  let adapter: any;
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = new ClaudeCodeAdapter();
    writes = [];
    adapter.ptyManager = { write: (s: string) => writes.push(s) };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function send(action: 'increase' | 'decrease' | 'commit' | 'cancel'): boolean {
    return adapter.handleAgentCommand({ type: 'set_effort', action });
  }

  it('opens the picker on the first nudge, then sends the arrow', () => {
    expect(send('increase')).toBe(true);
    expect(writes).toEqual(['/model\r']);

    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);
    expect(writes).toEqual(['/model\r', '\x1b[C']); // → right arrow
  });

  it('sends a bare arrow while the picker is already open', () => {
    send('increase');
    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);
    writes.length = 0;

    send('decrease');
    expect(writes).toEqual(['\x1b[D']); // ← left arrow, no second /model
  });

  it('confirms with Enter and closes the window', () => {
    send('increase');
    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);
    writes.length = 0;

    send('commit');
    expect(writes).toEqual(['\r']);

    // Window is closed, so the next nudge must reopen the picker.
    writes.length = 0;
    send('increase');
    expect(writes).toEqual(['/model\r']);
  });

  it('cancels with Esc', () => {
    send('increase');
    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);
    writes.length = 0;

    send('cancel');
    expect(writes).toEqual(['\x1b']);
  });

  it('ignores commit and cancel when no picker was opened', () => {
    // A stray Enter would submit whatever is on the prompt line; a stray Esc
    // mid-turn would interrupt the agent.
    expect(send('commit')).toBe(true);
    expect(send('cancel')).toBe(true);
    expect(writes).toEqual([]);
  });

  it('reopens the picker once the window has expired', () => {
    send('increase');
    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);
    writes.length = 0;

    // The user may have closed the picker from the keyboard; we never see that,
    // so the assumption times out rather than persisting forever.
    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_TTL_MS + 1);
    send('increase');
    expect(writes).toEqual(['/model\r']);
  });

  it('each nudge extends the open window', () => {
    send('increase');
    vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);

    // Nudge just under the TTL repeatedly — the picker must stay considered open.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(ClaudeCodeAdapter.EFFORT_PICKER_TTL_MS - 1000);
      writes.length = 0;
      send('increase');
      expect(writes).toEqual(['\x1b[C']);
    }
  });

  it('leaves unrelated commands to the base adapter', () => {
    expect(adapter.handleAgentCommand({ type: 'interrupt' })).toBe(false);
  });
});
