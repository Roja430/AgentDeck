/**
 * Session navigation dial (Stream Deck+).
 *
 * The Codex Micro joystick equivalent: rotate to move between agent sessions,
 * press to jump to the one under the cursor. The keypad already does this when
 * every session has a key; this covers the case it cannot — more sessions than
 * keys, or switching without leaving the detail view.
 *
 * Rotation is local only. Nothing is sent until the press, so spinning past a
 * session never steals focus from the agent you are watching.
 *
 * The cursor itself lives in `session-dial-state.ts` — this file imports
 * `@elgato/streamdeck`, which the test runner cannot load.
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
import type { SessionInfo } from '@agentdeck/shared';
import {
  encoderRegistry,
  isDaemonConnected,
  rememberEncoderColumn,
  forgetEncoderColumn,
} from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderSessionDial } from '../renderers/session-dial-renderer.js';
import { paintOfflineBanner } from '../offline-banner.js';
import { SessionDialState } from '../session-dial-state.js';
import { dlog } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/macos.js';
import {
  isTakeoverActive,
  handleTakeoverRotate,
  handleTakeoverPress,
} from '../encoder-takeover.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

export interface SessionDialHandlers {
  /** Focus a session and enter its detail view. */
  focus: (sessionId: string) => void;
  /** Leave the detail view. */
  back: () => void;
}

let handlers: SessionDialHandlers | null = null;
const state = new SessionDialState();

export function initSessionDial(h: SessionDialHandlers): void {
  handlers = h;
}

/** Called from plugin.ts on sessions_list. */
export function updateSessionDialSessions(list: SessionInfo[], focused?: string): void {
  state.setSessions(list, focused);
  refreshSessionDials();
}

export function refreshSessionDial(): void {
  refreshSessionDials();
}

function refreshSessionDials(): void {
  if (isDisplayDimmed()) return;
  if (isTakeoverActive()) return;
  if (encoderRegistry.sessionNavIds.length === 0) return;

  for (const id of encoderRegistry.sessionNavIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }

  if (!isDaemonConnected()) {
    paintOfflineBanner(encoderRegistry.sessionNavIds);
    return;
  }

  const feedback = {
    canvas: svgToDataUrl(renderSessionDial({
      sessions: state.getSessions(),
      cursor: state.getCursor(),
      focusedId: state.getFocusedId(),
    })),
  };
  for (const id of encoderRegistry.sessionNavIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.session-dial' })
export class SessionDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.sessionNavIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.sessionNavIds.includes(ev.action.id)) {
      encoderRegistry.sessionNavIds.push(ev.action.id);
    }
    rememberEncoderColumn(ev.action.id, (ev.payload as any).coordinates?.column);
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refreshSessionDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (!isDaemonConnected()) return;
    state.rotate(ev.payload.ticks);
    dlog('SessionDial', `rotate → ${state.getCursor() + 1}/${state.getSessions().length} ${state.current()?.id ?? '-'}`);
    refreshSessionDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isTakeoverActive()) { handleTakeoverPress(); return; }
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    const target = state.current();
    if (!target) return;
    handlers?.focus(target.id);
    dlog('SessionDial', `push → focus ${target.id}`);
    refreshSessionDials();
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (isTakeoverActive()) return;
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    handlers?.back();
    dlog('SessionDial', 'tap → back');
    refreshSessionDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    forgetEncoderColumn(ev.action.id);
    const idx = encoderRegistry.sessionNavIds.indexOf(ev.action.id);
    if (idx !== -1) encoderRegistry.sessionNavIds.splice(idx, 1);
  }
}
