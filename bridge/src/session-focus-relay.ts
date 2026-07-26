/**
 * Session Focus Relay — daemon subscribes to a focused session bridge's
 * WebSocket to relay its full state events to all daemon clients,
 * and routes commands from daemon clients to the focused session.
 *
 * Only one session can be focused at a time. Focusing a new session
 * disconnects from the previous one.
 *
 * Events are passed to onEvent callback (not broadcast directly) so the
 * daemon can merge session state with daemon-level metadata (modelCatalog,
 * gatewayAvailable, ollamaStatus, etc.) before broadcasting.
 */

import WebSocket from 'ws';
import { listActive as listActiveSessions } from './session-registry.js';
import type { PluginCommand, BridgeEvent } from './types.js';
import { debug } from './logger.js';

const TAG = 'focus-relay';

/** Events relayed from focused session to daemon clients */
const RELAYED_EVENTS = new Set([
  'state_update',
  'prompt_options',
  'usage_update',
]);

/**
 * Commands routed from daemon clients to the focused session.
 *
 * An allowlist, so a command the deck sends but this set does not name is
 * dropped here without a word — which is exactly what happened to the steering
 * dials: they sent, the daemon discarded, and the terminal showed nothing.
 * Add the type here whenever a new session-directed command is introduced.
 */
const ROUTED_COMMANDS = new Set([
  'respond',
  'interrupt',
  'escape',
  'select_option',
  'send_prompt',
  'navigate_option',
  'switch_mode',
  'set_effort',
  'set_model',
]);

export type FocusEventHandler = (event: BridgeEvent) => void;

export class SessionFocusRelay {
  private ws: WebSocket | null = null;
  private focusedSessionId: string | null = null;
  private focusedPort: number | null = null;
  private onEvent: FocusEventHandler | null = null;
  private closed = false;

  /** Set handler for relayed events. Daemon should merge and broadcast. */
  setEventHandler(handler: FocusEventHandler): void {
    this.onEvent = handler;
  }

  /** Get currently focused session ID */
  getFocusedSessionId(): string | null {
    return this.focusedSessionId;
  }

  /** Focus a session by ID. Disconnects from previous session. */
  focus(sessionId: string): void {
    if (this.focusedSessionId === sessionId && this.ws?.readyState === WebSocket.OPEN) {
      debug(TAG, `Already focused on ${sessionId}`);
      return;
    }

    this.unfocus();

    const sessions = listActiveSessions();
    const session = sessions.find(s => s.id === sessionId && s.agentType !== 'daemon');
    if (!session) {
      debug(TAG, `Session ${sessionId} not found or is daemon`);
      return;
    }

    this.focusedSessionId = sessionId;
    this.focusedPort = session.port;
    debug(TAG, `Focusing session ${session.projectName}:${session.port}`);
    this.connect();
  }

  /** Unfocus current session. */
  unfocus(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.focusedSessionId) {
      debug(TAG, `Unfocused session ${this.focusedSessionId}`);
    }
    this.focusedSessionId = null;
    this.focusedPort = null;
  }

  /** Route a command to the focused session. Returns true if handled. */
  routeCommand(cmd: PluginCommand): boolean {
    if (!this.focusedSessionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (!ROUTED_COMMANDS.has(cmd.type)) {
      return false;
    }
    debug(TAG, `Routing ${cmd.type} → session ${this.focusedSessionId}`);
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  /** Stop relay entirely. */
  stop(): void {
    this.closed = true;
    this.unfocus();
  }

  private connect(): void {
    if (this.closed || !this.focusedPort) return;

    const ws = new WebSocket(`ws://127.0.0.1:${this.focusedPort}`);
    this.ws = ws;
    const sessionId = this.focusedSessionId;

    ws.on('open', () => {
      debug(TAG, `Connected to session ${sessionId} on port ${this.focusedPort}`);
    });

    ws.on('message', (raw: Buffer | string) => {
      if (this.focusedSessionId !== sessionId) return;

      try {
        const evt = JSON.parse(raw.toString()) as BridgeEvent;
        if (RELAYED_EVENTS.has(evt.type)) {
          debug(TAG, `Relay ${evt.type} from session ${sessionId}`);
          // prompt_options used to be source-less, allowing a late event from
          // the previous focus to become buttons for the newly selected session.
          // Stamp the captured relay identity before it leaves this boundary.
          const tagged = evt.type === 'prompt_options' && sessionId
            ? { ...evt, sessionId, focusedSessionId: sessionId }
            : evt;
          this.onEvent?.(tagged as BridgeEvent);
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on('close', () => {
      if (this.focusedSessionId === sessionId) {
        debug(TAG, `Session ${sessionId} WS closed`);
        this.ws = null;
      }
    });

    ws.on('error', () => {});
  }
}
