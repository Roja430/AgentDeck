/**
 * Reasoning-effort dial (Stream Deck+).
 *
 * The Codex Micro control this mirrors: rotate to adjust how hard the agent
 * thinks, press to confirm. Claude Code puts effort inside the `/model` picker,
 * so rotation nudges that picker with ← / →, the press confirms with Enter, and
 * a touch tap backs out with Esc.
 *
 * Rotation is inert unless the focused session is idle: the keystrokes land in
 * the live PTY, and an Esc sent mid-turn would interrupt the agent rather than
 * close a picker.
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
import { openAgentDeckAppOrGitHub } from '../utility-modes/macos.js';

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
/** Focused session state — gates whether keystrokes may be sent. */
let sessionState: State | undefined;
/** True between the first nudge and a commit/cancel, for the "adjusting" hint. */
let adjusting = false;

export function initEffortDial(sender: CommandSender): void {
  send = sender;
}

/** Called from plugin.ts on every state_update. */
export function updateEffortDial(
  state: State | undefined,
  model: string | undefined,
  effort: string | undefined,
): void {
  sessionState = state;
  modelName = model;
  effortLevel = effort;
  // Leaving idle means the picker cannot still be open.
  if (state !== State.IDLE) adjusting = false;
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
        ? renderEffortDial({ effortLevel, modelName, idle: sessionState === State.IDLE, adjusting })
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

/** Rotation and press only make sense while the agent is waiting for input. */
function canSteer(): boolean {
  return isDaemonConnected() && sessionState === State.IDLE;
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
    if (!canSteer()) {
      dlog('EffortDial', `rotate ignored — state=${sessionState ?? 'unknown'}`);
      return;
    }
    const action = ev.payload.ticks >= 0 ? 'increase' : 'decrease';
    adjusting = true;
    send?.({ type: 'set_effort', action });
    dlog('EffortDial', `rotate → ${action}`);
    refreshEffortDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    if (!adjusting) return; // nothing staged; don't send a stray Enter
    send?.({ type: 'set_effort', action: 'commit' });
    adjusting = false;
    dlog('EffortDial', 'push → commit');
    refreshEffortDials();
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    if (!adjusting) return;
    send?.({ type: 'set_effort', action: 'cancel' });
    adjusting = false;
    dlog('EffortDial', 'tap → cancel');
    refreshEffortDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.effortIds.indexOf(ev.action.id);
    if (idx !== -1) encoderRegistry.effortIds.splice(idx, 1);
  }
}
