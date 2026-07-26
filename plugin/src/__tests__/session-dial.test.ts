import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@agentdeck/shared';
import { renderSessionDial } from '../renderers/session-dial-renderer.js';
import { SessionDialState } from '../session-dial-state.js';

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, port: 9121, projectName: id, alive: true, state: 'idle', ...over } as SessionInfo;
}

describe('session dial cursor', () => {
  let state: SessionDialState;

  beforeEach(() => { state = new SessionDialState(); });

  it('follows the focused session when the list arrives', () => {
    state.setSessions([session('a'), session('b'), session('c')], 'c');
    expect(state.getCursor()).toBe(2);
  });

  it('keeps pointing at the focused session when the list is reordered', () => {
    state.setSessions([session('a'), session('b'), session('c')], 'c');
    state.setSessions([session('c'), session('a'), session('b')], 'c');
    expect(state.getCursor()).toBe(0);
  });

  it('clamps the cursor when sessions disappear', () => {
    state.setSessions([session('a'), session('b'), session('c')], 'c');
    state.setSessions([session('a')]);
    expect(state.getCursor()).toBe(0);
  });

  it('survives the list emptying entirely', () => {
    state.setSessions([session('a')], 'a');
    state.setSessions([]);
    expect(state.getCursor()).toBe(0);
    expect(state.current()).toBeUndefined();
  });

  it('wraps in both directions', () => {
    state.setSessions([session('a'), session('b'), session('c')]);
    state.rotate(-1);
    expect(state.current()?.id).toBe('c'); // wrapped backwards off the start
    state.rotate(1);
    expect(state.current()?.id).toBe('a');
  });

  it('rotating an empty list is a no-op, not a crash', () => {
    state.setSessions([]);
    state.rotate(1);
    expect(state.getCursor()).toBe(0);
  });
});

describe('renderSessionDial', () => {
  it('shows the position so rotation is legible past the key count', () => {
    const svg = renderSessionDial({
      sessions: [session('a'), session('b'), session('c')],
      cursor: 1,
    });
    expect(svg).toContain('2/3');
    expect(svg).toContain('b');
  });

  it('prefers the running tool over the model as the detail line', () => {
    const svg = renderSessionDial({
      sessions: [session('a', { currentTool: 'Edit', modelName: 'claude-opus-5' })],
      cursor: 0,
    });
    expect(svg).toContain('Edit');
    expect(svg).not.toContain('opus-5');
  });

  it('colours the entry by session state', () => {
    const idle = renderSessionDial({ sessions: [session('a', { state: 'idle' })], cursor: 0 });
    const err = renderSessionDial({ sessions: [session('a', { state: 'error' })], cursor: 0 });
    expect(idle).toContain('#34d399');
    expect(err).toContain('#f87171');
  });

  it('says so when nothing is running', () => {
    expect(renderSessionDial({ sessions: [], cursor: 0 })).toContain('none running');
  });

  it('truncates a long project name rather than overflowing the LCD', () => {
    const svg = renderSessionDial({
      sessions: [session('x', { projectName: 'a-very-long-project-name-that-will-not-fit' })],
      cursor: 0,
    });
    expect(svg).toContain('…');
  });

  it('clamps an out-of-range cursor instead of rendering undefined', () => {
    const svg = renderSessionDial({ sessions: [session('a'), session('b')], cursor: 99 });
    expect(svg).toContain('2/2');
  });
});
