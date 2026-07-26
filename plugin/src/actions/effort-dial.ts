/**
 * Reasoning-effort dial (Stream Deck+).
 *
 * The Codex Micro control this mirrors: rotate to choose how hard the agent
 * thinks, press to apply. Claude Code exposes `/effort <level>`, so rotation is
 * local — nothing reaches the agent until the press, which sends one command.
 *
 * It used to drive the `/model` picker with ← / → because that was where effort
 * lived when the dial was written. Rotating therefore typed into the live PTY,
 * and a mistimed Esc interrupted the agent instead of closing a picker.
 *
 * The press is still gated on idle: `/effort` is typed into the prompt, and
 * mid-turn it would be swallowed by the running agent.
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  TouchTapEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderEffortDial } from '../renderers/effort-dial-renderer.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { EFFORT_LEVELS, indexOfLevel, stepLevel } from '../effort-levels.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

/**
 * Injected rather than taking the raw link: these keystrokes must reach the
 * *focused session's* PTY, and plugin.ts already owns the session_command
 * wrapping that observed and managed sessions both need.
 */
type CommandSender = (command: { type: string; [key: string]: unknown }) => void;
let send: CommandSender | null = null;
/** Effort level reported by the bridge for the focused session. */
let effortLevel: string | undefined;
/** Model name, shown as context for the level. */
let modelName: string | undefined;
/** Focused session state — gates whether a command may be sent. */
let sessionState: State | undefined;
/** True while the cursor sits somewhere other than the reported level. */
let adjusting = false;
/** Cursor into EFFORT_LEVELS. Follows the agent until the user turns the dial. */
let cursor = 0;
/** False when no session is focused — the press has nowhere to go. */
let hasSession = false;

export function initEffortDial(sender: CommandSender): void {
  send = sender;
}

/**
 * Fed from `sessions_list` as well as `state_update`: an idle session emits no
 * state_update for minutes at a time, and gating the press on a value that only
 * arrives on change made the dial look dead.
 */
export function updateEffortDial(
  state: State | undefined,
  model: string | undefined,
  effort: string | undefined,
  focused = true,
): void {
  hasSession = focused;
  sessionState = state;
  modelName = model;
  effortLevel = effort;
  // Once the agent reports the level the cursor was aiming at, the pending
  // change has landed and the cursor goes back to following the agent.
  if (!adjusting || EFFORT_LEVELS[cursor] === effort?.toLowerCase()) {
    cursor = indexOfLevel(effort);
    adjusting = false;
  }
  refreshEffortDials();
}

export function refreshEffortDial(): void {
  refreshEffortDials();
}

function refreshEffortDials(): void {
  if (isDisplayDimmed()) return;
  if (encoderRegistry.effortIds.length === 0) return;

  const feedback = {
    canvas: svgToDataUrl(
      isDaemonConnected()
        ? renderEffortDial({
          // Show where the cursor is, not what the agent last reported — the
          // dial has to answer "what will pressing do" while being turned.
          effortLevel: EFFORT_LEVELS[cursor],
          modelName,
          idle: sessionState === State.IDLE,
          adjusting,
        })
        : renderOfflineTouchStrip(1),
    ),
  };
  for (const id of encoderRegistry.effortIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
      void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

/** The press types into the prompt, so it needs a focused, idle session. */
function canSteer(): boolean {
  return isDaemonConnected() && hasSession && sessionState === State.IDLE;
}

@action({ UUID: 'bound.serendipity.agentdeck.effort-dial' })
export class EffortDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.effortIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.effortIds.includes(ev.action.id)) {
      encoderRegistry.effortIds.push(ev.action.id);
    }
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refreshEffortDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Local only — the level is applied by the press, so turning the dial while
    // reading the LCD cannot disturb a session.
    const next = stepLevel(cursor, ev.payload.ticks);
    if (next === cursor) return;
    cursor = next;
    adjusting = EFFORT_LEVELS[cursor] !== effortLevel?.toLowerCase();
    dlog('EffortDial', `rotate → ${EFFORT_LEVELS[cursor]}`);
    refreshEffortDials();
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    if (!canSteer()) {
      dlog('EffortDial', `press ignored — state=${sessionState ?? 'unknown'}`);
      void (ev.action as any).showAlert?.().catch(() => {});
      return;
    }
    if (!adjusting) return; // already at this level; nothing to send
    send?.({ type: 'set_effort', action: 'set', level: EFFORT_LEVELS[cursor] });
    dlog('EffortDial', `press → /effort ${EFFORT_LEVELS[cursor]}`);
    refreshEffortDials();
  }

  /** Abandon a staged level and snap back to what the agent reports. */
  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected() || !adjusting) return;
    cursor = indexOfLevel(effortLevel);
    adjusting = false;
    dlog('EffortDial', 'tap → cancel');
    refreshEffortDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.effortIds.indexOf(ev.action.id);
    if (idx !== -1) encoderRegistry.effortIds.splice(idx, 1);
  }
}
