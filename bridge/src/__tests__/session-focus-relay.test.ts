/**
 * Which commands reach a focused session.
 *
 * `ROUTED_COMMANDS` is an allowlist, and a command missing from it is dropped
 * with no error anywhere — the deck sends, the daemon discards, the terminal
 * shows nothing. That is exactly how the steering dials shipped broken, so the
 * session-directed commands are pinned here.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { PluginCommand } from '../types.js';
import { SessionFocusRelay } from '../session-focus-relay.js';

describe('SessionFocusRelay.routeCommand', () => {
  let relay: SessionFocusRelay;
  let sent: string[];

  beforeEach(() => {
    relay = new SessionFocusRelay();
    sent = [];
    // Stand in for the socket to the session bridge.
    (relay as any).focusedSessionId = 'session-1';
    (relay as any).ws = { readyState: 1, send: (s: string) => sent.push(s) };
  });

  const routed = (cmd: PluginCommand) => relay.routeCommand(cmd);

  it('routes every command the deck sends at a session', () => {
    const commands: PluginCommand[] = [
      { type: 'respond', value: 'y' },
      { type: 'interrupt' },
      { type: 'escape' },
      { type: 'select_option', index: 0 },
      { type: 'send_prompt', text: 'go on' },
      { type: 'navigate_option', direction: 'up' },
      { type: 'switch_mode' },
      { type: 'set_effort', action: 'set', level: 'high' },
      { type: 'set_model', model: 'sonnet' },
    ] as PluginCommand[];

    for (const cmd of commands) {
      expect(routed(cmd), cmd.type).toBe(true);
    }
    expect(sent).toHaveLength(commands.length);
  });

  it('leaves daemon-level commands for the daemon to handle', () => {
    // These are answered by the daemon itself; forwarding them to a session
    // bridge would be a no-op at best.
    expect(routed({ type: 'focus_session', sessionId: 'x' } as PluginCommand)).toBe(false);
    expect(routed({ type: 'new_session', agent: 'claude', cwd: '/tmp' } as PluginCommand)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('routes nothing when no session is focused', () => {
    (relay as any).focusedSessionId = null;
    expect(routed({ type: 'set_model', model: 'sonnet' } as PluginCommand)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('routes nothing when the socket is not open', () => {
    (relay as any).ws = { readyState: 3, send: (s: string) => sent.push(s) };
    expect(routed({ type: 'set_effort', action: 'set', level: 'max' } as PluginCommand)).toBe(false);
    expect(sent).toEqual([]);
  });
});
