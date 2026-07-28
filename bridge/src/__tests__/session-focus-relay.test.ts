/**
 * Which commands reach a focused session.
 *
 * `ROUTED_COMMANDS` is an allowlist, and a command missing from it is dropped
 * with no error anywhere — the deck sends, the daemon discards, the terminal
 * shows nothing. That is exactly how the steering dials shipped broken, so the
 * session-directed commands are pinned here.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import WebSocket from 'ws';
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

/**
 * Switching focus must never be able to kill the daemon.
 *
 * `unfocus()` used to strip the socket's listeners and then close it. Closing a
 * socket that has not finished connecting aborts the handshake by EMITTING an
 * error, and an EventEmitter with no 'error' listener throws — so a client that
 * refocused a moment after the previous focus took the whole daemon down with
 * "WebSocket was closed before the connection was established".
 */
describe('SessionFocusRelay focus lifecycle', () => {
  it('survives unfocusing a socket that is still connecting', async () => {
    const relay = new SessionFocusRelay();
    // Port 1 never answers, so this stays CONNECTING for the whole test.
    const ws = new WebSocket('ws://127.0.0.1:1');
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    (relay as any).ws = ws;
    (relay as any).focusedSessionId = 'session-1';

    // ws aborts the handshake on a later tick, so the throw arrives as an
    // uncaught exception rather than out of the call below. Catch it here
    // instead of letting it poison whichever test happens to run next.
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      relay.unfocus();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught.map((e) => e.message)).toEqual([]);
    expect((relay as any).ws).toBeNull();
  });

  it('treats a still-connecting relay as already focused', () => {
    // Re-sending focus_session for the current session is normal client
    // behaviour (the deck's auto-focus repeats while the list shows the session
    // awaiting). Rebuilding the relay each time leaves a gap in which the
    // session's events reach nobody.
    const relay = new SessionFocusRelay();
    const ws = { readyState: WebSocket.CONNECTING } as any;
    (relay as any).ws = ws;
    (relay as any).focusedSessionId = 'session-1';

    relay.focus('session-1');

    expect((relay as any).ws).toBe(ws);
    expect(relay.getFocusedSessionId()).toBe('session-1');
  });
});
