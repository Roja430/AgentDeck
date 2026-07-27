/**
 * Agent-control dial (Stream Deck+) — model and permission mode on one encoder.
 *
 * Rotate to move through the roll, press to apply. Models come first, then the
 * permission modes; both are applied the same way from the user's side, which
 * is why they share one flat list instead of two tap-switched pages.
 *
 * The two halves reach the agent very differently. A model is set outright with
 * `/model <name>`. A permission mode has no such command — Shift+Tab cycles and
 * that is all — so reaching a chosen mode means nudging and watching what the
 * agent reports, which is what `seekMode` does.
 *
 * Ships unassigned: SD+ has four encoders and the default profile already
 * spends them, so placing this is the user's call (Codex Usage is the usual
 * trade when Codex is not in play).
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
import type { ModelCatalogEntry } from '@agentdeck/shared';
import { State } from '@agentdeck/shared';
import {
  encoderRegistry,
  isDaemonConnected,
  rememberEncoderColumn,
  forgetEncoderColumn,
} from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUtilityGeneric, type UtilityRenderData } from '../renderers/utility-renderer.js';
import { paintOfflineBanner } from '../offline-banner.js';
import { AgentDialState, MAX_MODE_STEPS } from '../agent-dial-state.js';
import { dlog, dinfo, dwarn } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';
/** Long enough to clear the adapter's 100ms Shift+Tab debounce and see the result. */
const MODE_STEP_INTERVAL_MS = 400;

type CommandSender = (command: { type: string; [key: string]: unknown }) => void;

let send: CommandSender | null = null;
const state = new AgentDialState();
let sessionState: State | undefined;
let hasSession = false;
let seeking: { target: string; attempts: number } | null = null;
let seekTimer: ReturnType<typeof setTimeout> | null = null;

export function initAgentDial(sender: CommandSender): void {
  send = sender;
}

export interface AgentDialInput {
  /** False when no session is focused — the press has nowhere to go. */
  hasSession: boolean;
  state?: State;
  modelName?: string;
  permissionMode?: string;
  catalog?: ModelCatalogEntry[];
}

/**
 * Fed from two places, because neither is sufficient alone: `sessions_list`
 * carries every focused session's state on a poll, while `state_update` only
 * arrives when something changes — an idle session can go minutes without one,
 * which is long enough for a dial gated on it to look broken.
 */
export function updateAgentDial(input: AgentDialInput): void {
  hasSession = input.hasSession;
  sessionState = input.state;
  if (input.catalog?.length) state.setCatalog(input.catalog);
  state.setActive(input.modelName, input.permissionMode ?? state.getActiveMode());
  // The agent reporting the target ends the nudging — this is the only signal
  // that the mode actually landed, since nothing acknowledges a Shift+Tab.
  if (seeking && input.permissionMode === seeking.target) stopSeeking();
  refreshAgentDials();
}

export function refreshAgentDial(): void {
  refreshAgentDials();
}

function stopSeeking(): void {
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = null;
  seeking = null;
}

/**
 * Nudge the permission mode until the agent reports the target.
 *
 * Bounded, and verified against what comes back rather than against an assumed
 * cycle order: which modes are in the rotation depends on the user's settings,
 * so counting steps blind would land somewhere else on a machine configured
 * differently.
 */
function seekMode(target: string): void {
  if (state.getActiveMode() === target) return;
  stopSeeking();
  seeking = { target, attempts: 0 };
  stepMode();
}

function stepMode(): void {
  if (!seeking) return;
  if (state.getActiveMode() === seeking.target) {
    stopSeeking();
    return;
  }
  if (seeking.attempts >= MAX_MODE_STEPS) {
    dwarn('AgentDial', `mode ${seeking.target} not reached in ${MAX_MODE_STEPS} steps`);
    stopSeeking();
    refreshAgentDials();
    return;
  }
  // Never cycle blind. Without a reported mode there is no way to know where
  // the nudges are landing, and a run of them would leave the agent on an
  // arbitrary permission setting — the one outcome worth avoiding here.
  if (seeking.attempts > 0 && state.getActiveMode() === undefined) {
    dwarn('AgentDial', 'agent reports no permission mode — not cycling further');
    stopSeeking();
    refreshAgentDials();
    return;
  }
  seeking.attempts += 1;
  send?.({ type: 'switch_mode' });
  dlog('AgentDial', `switch_mode → seeking ${seeking.target} (${seeking.attempts})`);
  seekTimer = setTimeout(stepMode, MODE_STEP_INTERVAL_MS);
}

function refreshAgentDials(): void {
  if (isDisplayDimmed()) return;
  if (encoderRegistry.agentIds.length === 0) return;

  for (const id of encoderRegistry.agentIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }

  if (!isDaemonConnected()) {
    paintOfflineBanner(encoderRegistry.agentIds);
    return;
  }

  const feedback = { canvas: svgToDataUrl(buildCanvas()) };
  for (const id of encoderRegistry.agentIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

function buildCanvas(): string {
  const entry = state.current();
  const entries = state.getEntries();
  // The page name leads, because tapping to swap pages is the one interaction
  // on this dial with no visual affordance of its own.
  const title = state.getPage() === 'model' ? 'モデル ⇄' : 'モード ⇄';

  if (!entry || !hasSession) {
    // The roll is still there — this says the press has nowhere to go, which is
    // fixed by focusing a session on the keypad, not by turning the dial.
    return renderUtilityGeneric({
      title,
      icon: '○',
      value: entry ? `${entry.label}・未選択` : 'セッションなし',
      indicator: { value: 0, bar_fill_c: '#64748b' },
    });
  }

  const active = state.isCurrentActive();
  const data: UtilityRenderData = {
    title,
    icon: seeking ? '⏳' : (active ? '●' : '○'),
    value: entry.label,
    indicator: {
      value: entries.length > 1 ? (state.getCursor() / (entries.length - 1)) * 100 : 0,
      bar_fill_c: active ? '#22c55e' : '#64748b',
    },
  };
  return renderUtilityGeneric(data);
}

@action({ UUID: 'bound.serendipity.agentdeck.agent-dial' })
export class AgentDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.agentIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('AgentDial', `onWillAppear: id=${ev.action.id} controller=${ev.payload.controller}`);
    if (!encoderRegistry.agentIds.includes(ev.action.id)) {
      encoderRegistry.agentIds.push(ev.action.id);
    }
    rememberEncoderColumn(ev.action.id, (ev.payload as any).coordinates?.column);
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refreshAgentDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Local only. Nothing reaches the agent until the press, so spinning past
    // an entry never changes the model a running turn is using.
    state.rotate(ev.payload.ticks);
    dlog('AgentDial', `rotate → ${state.current()?.label ?? '-'}`);
    refreshAgentDials();
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    const entry = state.current();
    if (!entry) return;

    // Both `/model` and Shift+Tab are typed into the prompt; mid-turn they would
    // be swallowed by the running agent or, worse, interrupt it.
    if (!hasSession || sessionState !== State.IDLE) {
      dlog('AgentDial', `press ignored — state=${sessionState ?? 'unknown'}`);
      void (ev.action as any).showAlert?.().catch(() => {});
      return;
    }

    if (entry.kind === 'model') {
      send?.({ type: 'set_model', model: entry.value });
      dlog('AgentDial', `press → /model ${entry.value}`);
    } else {
      seekMode(entry.value);
    }
    refreshAgentDials();
  }

  /** Swap between the model page and the mode page. */
  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // A page swap must not leave a mode hunt running against the page the user
    // just left.
    stopSeeking();
    dlog('AgentDial', `tap → ${state.togglePage()} page`);
    refreshAgentDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    forgetEncoderColumn(ev.action.id);
    const idx = encoderRegistry.agentIds.indexOf(ev.action.id);
    if (idx !== -1) encoderRegistry.agentIds.splice(idx, 1);
    if (encoderRegistry.agentIds.length === 0) stopSeeking();
  }
}
