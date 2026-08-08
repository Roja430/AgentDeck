import streamDeck from '@elgato/streamdeck';
import {
  StateUpdateEvent,
  PromptOptionsEvent,
  UsageEvent,
  ConnectionEvent,
  UserPromptEvent,
  State,
  PermissionMode,
  OPENCLAW_GATEWAY_PORT,
  type AgentType,
  type DeckSlotConfig,
  type DeckSlotMapEvent,
  type SessionInfo,
  type SessionsListEvent,
} from '@agentdeck/shared';

import { ConnectionManager } from './connection-manager.js';
import { updateUsageModeData, setUsageRefreshCallback } from './utility-modes/usage.js';
import { setEncoderDaemonConnected } from './encoder-registry.js';
import { dlog, dinfo } from './log.js';

// Encoder actions
import {
  ResponseDialAction,
  initOptionDial,
  updateClaudeUsageDial,
  refreshClaudeUsageDial,
} from './actions/option-dial.js';
import {
  EffortDialAction,
  initEffortDial,
  updateEffortDial,
  refreshEffortDial,
} from './actions/effort-dial.js';
import {
  SessionDialAction,
  initSessionDial,
  updateSessionDialSessions,
  refreshSessionDial,
} from './actions/session-dial.js';
import {
  AgentDialAction,
  initAgentDial,
  updateAgentDial,
  refreshAgentDial,
} from './actions/agent-dial.js';
import {
  LauncherDialAction,
  initLauncherDial,
  updateLauncherDialState,
  updateLauncherProjects,
} from './actions/launcher-dial.js';
import {
  UtilityDialAction,
  initUtilityDial,
  updateUtilityDialState,
} from './actions/utility-dial.js';
import {
  UsageDialAction,
  initUsageDial,
  updateUsageDialData,
  updateUsageDialState,
} from './actions/iterm-dial.js';
import {
  SessionSlotButtonAction,
  initSessionSlots,
  updateSessionSlotSessions,
  updateDetailViewState,
  exitDetailView,
  isInDetailView,
  getSessionSlotManager,
  getFocusedSession,
  setDaemonConnected,
  setDaemonStale,
  updateSlotUsage,
  markSessionReviewPending,
  clearSessionReviewPending,
  refreshSessionSlots,
} from './actions/session-slot-button.js';
import { isDisplayDimmed, setDisplayDimmed, dimActionIfNeeded } from './display-dim.js';
import { initEncoderTakeover, syncEncoderTakeover, resetEncoderTakeover } from './encoder-takeover.js';
import { hasSessionEnded, soleAwaitingSession } from './encoder-takeover-state.js';
import { FocusedDetailState, type FocusedDetailSnapshot } from './focused-detail-state.js';

// ---- Shared state ----
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentOptions: import('@agentdeck/shared').PromptOption[] = [];
let proxiedAgentType: AgentType | null = null;

const focusedDetailState = new FocusedDetailState();

function renderFocusedDetail(snapshot: FocusedDetailSnapshot): void {
  // Both surfaces are driven from this one snapshot. Giving the encoders their
  // own copy of the options is what would let the two disagree about what is on
  // offer, so they are fed here rather than from a separate event path.
  syncEncoderTakeover({
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    options: snapshot.options,
    question: snapshot.question,
    session: getFocusedSession(),
  });
  updateDetailViewState(
    snapshot.state,
    snapshot.options,
    snapshot.tool,
    snapshot.toolInput,
    snapshot.question,
    snapshot.modelName,
    snapshot.mode,
    snapshot.effortLevel,
    snapshot.suggestedPrompt,
  );
}

function primeDetailViewFromSession(session?: SessionInfo): void {
  if (!session) {
    leaveDetailView();
    return;
  }
  renderFocusedDetail(focusedDetailState.prime(session));
}

/**
 * Drop the focused snapshot and hand the encoders back.
 *
 * Clearing the snapshot alone left the takeover holding E1–E4 for a prompt that
 * is no longer on screen: nothing else was ever going to tell it, since the
 * takeover only learns about the world through `renderFocusedDetail`, which
 * stops being called the moment the detail view goes away.
 */
function leaveDetailView(): void {
  focusedDetailState.clear();
  resetEncoderTakeover();
}

function sendFocusedSessionCommand(command: { type: string; [key: string]: unknown }): void {
  const focused = getFocusedSession();
  // Wrap in session_command for any session the daemon can route: managed
  // bridges (port > 0) get PTY delivery; observed sessions get the daemon's
  // hook-steering primitives (soft STOP / turn-end queue / gate resolution).
  // The old code excluded observed here, which made their buttons fall through
  // to a bare daemon command that was silently dropped.
  if (
    focused &&
    focused.agentType !== 'openclaw' &&
    (focused.port > 0 || focused.controlMode === 'observed')
  ) {
    dinfo('Plugin', `-> session_command ${command.type} to ${focused.id}`);
    connMgr.send({ type: 'session_command', sessionId: focused.id, command } as any);
    return;
  }
  // The bare fallback only lands if the daemon happens to hold a focus of its
  // own; with no focused session it is dropped without a word. Say so, because
  // from the deck this is indistinguishable from a key that did nothing.
  dinfo('Plugin', `-> bare ${command.type} (no focused session — daemon may drop this)`);
  connMgr.send(command as any);
}

// ---- Instances ----
const connMgr = new ConnectionManager();

// ---- Initialize action modules ----
initOptionDial(connMgr);
initEffortDial(sendFocusedSessionCommand);
initAgentDial(sendFocusedSessionCommand);
initEncoderTakeover({
  selectOption: (index) => sendFocusedSessionCommand({ type: 'select_option', index }),
  restoreDials: () => repaintAllDials(),
});
initSessionDial({
  focus: (sessionId) => {
    // Same path the keypad takes, so the dial and the keys cannot disagree
    // about what 'focused' means.
    const mgr = getSessionSlotManager();
    mgr.enterDetailView(sessionId);
    connMgr.focusSession(sessionId);
    primeDetailViewFromSession(mgr.getFocusedSession());
    broadcastStateUpdate();
  },
  back: () => {
    leaveDetailView();
    exitDetailView();
    broadcastStateUpdate();
  },
});
initLauncherDial((c) => connMgr.send(c as any));
initUtilityDial();
initUsageDial(connMgr);

// ---- Initialize v4 utility mode callbacks ----
setUsageRefreshCallback(() => {
  connMgr.send({ type: 'query_usage' });
});
// ---- Initialize v4 session slot buttons ----
initSessionSlots((result) => {
  dinfo('Plugin', `sessionSlot action: ${result.action} session=${result.sessionId ?? '-'} port=${result.sessionPort ?? '-'}`);

  switch (result.action) {
    case 'enter-detail': {
      if (!result.sessionId) break;
      const mgr = getSessionSlotManager();
      mgr.enterDetailView(result.sessionId);

      // Tell daemon to focus this session (daemon relays its state)
      const session = mgr.getFocusedSession();
      if (session?.agentType === 'openclaw') {
        connMgr.switchToOpenClaw();
      } else {
        connMgr.focusSession(result.sessionId);
      }

      // Prime with the selected session's own list-state. The focused
      // session relay will replace this with full tool/options shortly.
      primeDetailViewFromSession(session);
      broadcastStateUpdate();  // refresh encoders (timeline ↔ normal)
      break;
    }

    case 'exit-detail':
      leaveDetailView();
      exitDetailView();
      broadcastStateUpdate();  // refresh encoders (timeline ↔ normal)
      break;

    case 'select-option':
      if (result.optionIndex != null) {
        sendFocusedSessionCommand({ type: 'select_option', index: result.optionIndex });
      }
      break;

    case 'send-prompt':
      if (result.promptText) {
        sendFocusedSessionCommand({ type: 'send_prompt', text: result.promptText });
      }
      break;

    case 'open-gateway':
      import('./utility-modes/macos.js').then(({ openOrFocusBrowserTab }) => {
        void openOrFocusBrowserTab(`http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`).catch(() => {});
      });
      break;

    case 'switch-model': {
      const mgr = getSessionSlotManager();
      mgr.startModelSwitch();
      sendFocusedSessionCommand({ type: 'send_prompt', text: '/model' });
      // Refresh to show loading state immediately
      if (isInDetailView()) {
        primeDetailViewFromSession(getFocusedSession());
      }
      break;
    }

    case 'review-run': {
      // Independent on-demand eval — a daemon-level command (the daemon
      // resolves the session's work product + judge), never a PTY prompt.
      const focused = getFocusedSession();
      if (focused) {
        connMgr.send({ type: 'review_run', sessionId: focused.id } as any);
        // Instant press-ack: flip the tile to REVIEWING before the daemon's
        // review_status/sessions_list round trip (which can lag many seconds
        // while a judge is busy). Cleared on refusal via review_status error.
        markSessionReviewPending(focused.id);
      }
      break;
    }

    case 'fork-session': {
      // A daemon-level command, not a PTY prompt: forking opens a new terminal
      // running `claude --resume … --fork-session`, which only the daemon can do.
      const focused = getFocusedSession();
      if (focused) connMgr.send({ type: 'fork_session', sessionId: focused.id } as any);
      break;
    }

    case 'stop':
      sendFocusedSessionCommand({ type: 'interrupt' });
      break;

    case 'esc':
      sendFocusedSessionCommand({ type: 'escape' });
      break;

    case 'refresh-usage':
      connMgr.send({ type: 'query_usage' });
      break;
  }
});

// ---- Bridge event handlers ----

connMgr.on('state_update', (ev: StateUpdateEvent) => {
  dlog('Plugin', `state_update: ${ev.state} mode=${ev.permissionMode} tool=${ev.currentTool || '-'} project=${ev.projectName || '-'} opts=${ev.options?.length ?? '-'} nav=${ev.navigable ?? '-'}`);

  currentState = ev.state;
  currentMode = ev.permissionMode;

  // Reasoning-effort dial mirrors the focused session: the level itself, the
  // model it belongs to, and the state that decides whether it may steer.
  // Only a session-scoped event may steer these. The daemon broadcasts its OWN
  // state on every focus change and stamps the focused session's id onto it —
  // its state is DISCONNECTED, since it runs no agent, and letting that through
  // left both dials permanently refusing the press.
  if (ev.agentType !== ('daemon' as unknown as typeof ev.agentType)) {
    updateEffortDial(ev.state, ev.modelName, ev.effortLevel, true);
    // Agent-control dial: permissionMode is the only acknowledgement a
    // Shift+Tab ever gets.
    updateAgentDial({
      hasSession: true,
      state: ev.state,
      modelName: ev.modelName,
      permissionMode: ev.permissionMode,
      catalog: ev.modelCatalog,
    });
  }

  // Track proxied agent type from daemon (state_update.agentType overrides connection-level detection)
  if (ev.agentType === 'openclaw' || ev.agentType === 'claude-code' || ev.agentType === 'codex-cli' || ev.agentType === 'codex-app' || ev.agentType === 'opencode' || ev.agentType === 'antigravity') {
    proxiedAgentType = ev.agentType;
  }

  // Use options from state_update atomically (avoids race with separate prompt_options)
  if (ev.options && ev.options.length > 0) {
    currentOptions = ev.options;
  } else if (
    ev.state !== State.AWAITING_OPTION &&
    ev.state !== State.AWAITING_PERMISSION &&
    ev.state !== State.AWAITING_DIFF
  ) {
    currentOptions = [];
  }

  // Keypad detail state is session-owned. Never render it from the plugin's
  // global caches: those intentionally follow the latest daemon/agent event.
  if (isInDetailView()) {
    const focused = getFocusedSession();
    const detail = focused ? focusedDetailState.applyState(ev, focused) : null;
    if (detail) {
      renderFocusedDetail(detail);
    } else if (focused) {
      dlog('Plugin', `drop detail state_update source=${ev.focusedSessionId || ev.sessionId || '-'} focused=${focused.id}`);
    }
  }

  broadcastStateUpdate();
});

connMgr.on('prompt_options', (ev: PromptOptionsEvent) => {
  dlog('Plugin', `prompt_options: source=${ev.focusedSessionId || ev.sessionId || '-'} type=${ev.promptType} count=${ev.options.length} q=${ev.question ? `"${ev.question.slice(0, 40)}"` : '-'}`);
  currentOptions = ev.options;
  if (isInDetailView()) {
    const focused = getFocusedSession();
    const detail = focused ? focusedDetailState.applyOptions(ev, focused) : null;
    if (detail) {
      renderFocusedDetail(detail);
    } else if (focused) {
      dlog('Plugin', `drop prompt_options source=${ev.focusedSessionId || ev.sessionId || '-'} focused=${focused.id}`);
    }
  }
  broadcastStateUpdate();
});

connMgr.on('usage_update', (ev: UsageEvent) => {
  dlog('Plugin', `usage_update: 5h=${ev.fiveHourPercent ?? '-'}% 7d=${ev.sevenDayPercent ?? '-'}% extra=${ev.extraUsageEnabled ? 'on' : 'off'} tokens=${ev.inputTokens + ev.outputTokens}`);

  // Feed usage data to shared store + dedicated E3 Usage Dial
  const usageData = {
    fiveHourPercent: ev.fiveHourPercent,
    fiveHourResetsAt: ev.fiveHourResetsAt,
    sevenDayPercent: ev.sevenDayPercent,
    sevenDayResetsAt: ev.sevenDayResetsAt,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    estimatedCostUsd: ev.estimatedCostUsd,
    sessionDurationSec: ev.sessionDurationSec,
    extraUsageEnabled: ev.extraUsageEnabled,
    extraUsageUtilization: ev.extraUsageUtilization,
    extraUsageMonthlyLimit: ev.extraUsageMonthlyLimit,
    extraUsageUsedCredits: ev.extraUsageUsedCredits,
    subscriptions: ev.subscriptions,
    usageStale: ev.usageStale,
  };
  // Codex rate limits (primary≈5h, secondary≈7d) ride alongside the Claude
  // 5h/7d quota so every usage surface can draw both agents. transcriptCost is
  // the locally-derived dollar figure the quota percentages can't express.
  const merged = { ...usageData, codexRateLimits: ev.codexRateLimits, transcriptCost: ev.transcriptCost };
  updateUsageModeData(merged);
  // SD+ encoders: E2 = Claude usage water-tank, E3 = Codex usage water-tank.
  updateClaudeUsageDial(merged);
  updateUsageDialData(merged);
  // v4: feed the pinned list-view water-tank usage tiles (classic SD / XL — no
  // encoder, so usage lives on the bottom keypad row).
  updateSlotUsage(merged);
});

connMgr.on('connection', (ev: ConnectionEvent) => {
  dinfo('Plugin', `connection: ${ev.status}`);
  if (ev.status === 'disconnected') {
    focusedDetailState.clear();
    currentState = State.DISCONNECTED;
    currentOptions = [];
    // Drop the takeover explicitly: no further snapshot is coming to turn it
    // off, so the dials would keep showing a prompt nobody can answer.
    resetEncoderTakeover();
    broadcastStateUpdate();
  }
  // 'connected' case: state_update (sent before connection event) already
  // set the correct state — don't clobber it to IDLE here.
});

// ---- v4 Session Slot: sessions_list → slot assignment ----
// SessionsListEvent from the SSOT rather than an inline shape — the inline one
// silently omitted every field added to the event after it was written.
connMgr.on('sessions_list', (ev: SessionsListEvent) => {
  dlog('Plugin', `sessions_list: ${ev.sessions.length} sessions`);
  updateSessionSlotSessions(ev.sessions);
  updateSessionDialSessions(ev.sessions, getFocusedSession()?.id);
  updateLauncherProjects(ev.recentProjects ?? []);

  // A prompt is only answerable from the dials once its session is focused, and
  // asking the user to go find it defeats the point of surfacing it. Focus it
  // for them — but only when exactly one session is waiting, since with two the
  // deck would be choosing whose prompt gets the dials.
  if (!isInDetailView()) {
    const sole = soleAwaitingSession(ev.sessions);
    if (sole) {
      // Log the row's shape, not just its id: "auto-focus fired but the
      // takeover never engaged" is unanswerable without knowing whether the
      // row carried any options and whether the session can be answered at all.
      dinfo('Plugin', `auto-focus ${sole.id} — sole awaiting session `
        + `(${sole.controlMode ?? 'managed'}, ${sole.state}, ${(sole.options ?? []).length} option(s))`);
      getSessionSlotManager().enterDetailView(sole.id);
      connMgr.focusSession(sole.id);
      primeDetailViewFromSession(sole);
    }
  }

  // The steering dials read the focused session from here as well as from
  // state_update. sessions_list is polled, so it keeps reporting an idle
  // session; state_update only fires on change, and an agent sitting at the
  // prompt produces none for minutes at a time.
  const steered = getFocusedSession();
  const steeredState = steered?.state as State | undefined;
  updateEffortDial(steeredState, steered?.modelName, steered?.effortLevel, !!steered);
  updateAgentDial({
    hasSession: !!steered,
    state: steeredState,
    modelName: steered?.modelName,
  });
  if (isInDetailView()) {
    const focused = getFocusedSession();
    const snapshot = focusedDetailState.snapshot;
    if (hasSessionEnded(focused)) {
      // Closing the terminal on an open prompt is not something the session can
      // report — it is dead. Left alone, the encoders keep offering choices
      // with nowhere to send them, and a press silently goes nowhere.
      if (snapshot) dinfo('Plugin', `focused session ended — releasing the encoders`);
      leaveDetailView();
      exitDetailView();
    // A Codex fold can replace the selected thread id. Observed sessions have
    // no focused bridge relay, so their sessions_list row is always canonical.
    } else if (focused && (snapshot?.sessionId !== focused.id || focused.controlMode === 'observed')) {
      primeDetailViewFromSession(focused);
    } else if (focused) {
      // Self-heal, in both directions. A prompt raised before this client
      // focused the session sends no state_update — nothing is coming — so the
      // list row is the only place it exists. And a prompt cleared while the
      // relay was down is invisible the same way: the encoders would keep
      // offering answers to a question that is gone. The row is the only
      // channel that survives either gap, so it is read both ways; the state
      // itself enforces that a stale row cannot fight a live snapshot.
      const adopted = focusedDetailState.adoptPromptFromSession(focused);
      if (adopted) {
        dinfo('Plugin', `adopted prompt for ${focused.id} from sessions_list — ${adopted.options.length} option(s)`);
        renderFocusedDetail(adopted);
      } else {
        const released = focusedDetailState.releasePromptFromSession(focused);
        if (released) {
          dinfo('Plugin', `released prompt for ${focused.id} — sessions_list says ${focused.state}, no options`);
          renderFocusedDetail(released);
        }
      }
    }
  } else {
    leaveDetailView();
  }
});

connMgr.on('user_prompt', (ev: UserPromptEvent) => {
  dlog('Plugin', `user_prompt: "${ev.text.slice(0, 60)}"`);
});

// Review lifecycle: an error (mid-turn refusal, judge failure) must clear the
// optimistic REVIEWING flip set at press time — success flows through the
// sessions_list reviewStatus badge instead.
connMgr.on('review_status', (ev: { type: 'review_status'; sessionId: string; status: string; message?: string }) => {
  dlog('Plugin', `review_status: ${ev.sessionId} ${ev.status}${ev.message ? ` (${ev.message})` : ''}`);
  if (ev.status === 'error' && ev.sessionId) clearSessionReviewPending(ev.sessionId);
});

// ---- Display sleep/wake dimming ----
// The gate itself lives in display-dim.ts so the per-action repaint paths that
// never pass through broadcastStateUpdate() (usage ticks, the volume poll, the
// awaiting animation) can consult it too.

function dimAllActions(): void {
  for (const [actionId, entry] of appearedActions.entries()) {
    const act = streamDeck.actions.getActionById(actionId);
    if (!act) continue;
    dimActionIfNeeded(act, entry.controller);
  }
}

connMgr.on('display_state', (ev: {
  type: 'display_state';
  displayOn: boolean;
  dim?: { enabled?: boolean; mode?: 'off' | 'min'; level?: number };
}) => {
  // The SDK exposes no key brightness, so "dark" can only be black pixels.
  // That makes mode "min" (dim but readable) unrepresentable — blanking would
  // hide more than it dims — so only "off" blanks; "min" stays lit. Honor
  // `enabled: false` too: the user turned dimming off, and blanking anyway was
  // the previous behavior because this handler never parsed `dim` at all.
  const dimEnabled = ev.dim?.enabled !== false;
  const blanks = ev.dim?.mode !== 'min';
  const shouldDim = !ev.displayOn && dimEnabled && blanks;
  // The daemon re-sends this every 15 s whether anything changed or not, so an
  // unconditional INFO here buried the log it was raised to INFO to help read:
  // 1670 of 1685 lines. Only the edges are news; the repeats stay at debug.
  const shape = `displayOn=${ev.displayOn} enabled=${dimEnabled} mode=${ev.dim?.mode ?? 'off'}`;
  if (shouldDim && !isDisplayDimmed()) {
    dinfo('Plugin', `display_state: blanking the deck — ${shape}`);
    setDisplayDimmed(true);
    dimAllActions();
  } else if (!shouldDim && isDisplayDimmed()) {
    dinfo('Plugin', `display_state: waking the deck — ${shape}`);
    setDisplayDimmed(false);
    broadcastStateUpdate(); // Re-render everything
  } else {
    dlog('Plugin', `display_state: ${shape} (no change)`);
  }
});

// Announce ourselves so the daemon's Dashboard → Downstream rail can surface
// a "Stream Deck" row with the physical devices this plugin sees. Called
// from `connected` (initial registration) and from device hot-plug events
// (so the row updates without waiting for the daemon's 120 s TTL eviction).
// DeviceType 7 = Stream Deck+, 0 = Stream Deck, 1 = Stream Deck Mini,
// 2 = Stream Deck XL, 6 = Stream Deck Pedal.
function sendClientRegister(reason: string): void {
  const familyFor = (type: number | undefined): string => {
    switch (type) {
      case 0: return 'streamdeck';
      case 1: return 'streamdeckmini';
      case 2: return 'streamdeckxl';
      case 6: return 'streamdeckpedal';
      case 7: return 'streamdeckplus';
      default: return 'streamdeck-unknown';
    }
  };
  const devices = Array.from(streamDeck.devices).map((d: any) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    family: familyFor(d.type as number | undefined),
    columns: d.size?.columns as number | undefined,
    rows: d.size?.rows as number | undefined,
  }));
  dinfo('Plugin', `client_register (${reason}) devices=${devices.length} families=[${devices.map(d => d.family).join(',')}]`);
  connMgr.send({
    type: 'client_register',
    clientType: 'streamdeck-plugin',
    clientLabel: 'Stream Deck',
    devices,
  });
}

// Re-announce on hot-plug. The Elgato SDK fires these for each physical
// device add/remove; SDK-side `streamDeck.devices` is updated *before* the
// listener runs, so the snapshot inside sendClientRegister picks up the
// change. send() is a no-op if WS is down — the `connected` handler below
// will resend on reconnect.
streamDeck.devices.onDeviceDidConnect(() => sendClientRegister('deviceDidConnect'));
streamDeck.devices.onDeviceDidDisconnect(() => sendClientRegister('deviceDidDisconnect'));

connMgr.on('connected', () => {
  dinfo('Plugin', `connected (agentType=${proxiedAgentType} prevState=${currentState})`);
  setDaemonConnected(true);
  setEncoderDaemonConnected(true);
  currentState = State.IDLE;
  // Re-send slot map so bridge knows our layout when the WS comes up after
  // the plugin has already loaded (onWillAppear's first send may have been
  // dropped because the bridge was not yet connected).
  sendSlotMap();
  sendClientRegister('connected');
  // Request fresh usage data immediately on connect (covers sleep/wake recovery)
  connMgr.send({ type: 'query_usage' });
  broadcastStateUpdate();
});

connMgr.on('stale-changed', (stale: boolean) => {
  dinfo('Plugin', `daemon stale-changed: ${stale}`);
  setDaemonStale(stale);
});

connMgr.on('disconnected', () => {
  dinfo('Plugin', `disconnected (agentType=${proxiedAgentType} prevState=${currentState})`);
  setDaemonConnected(false);
  setEncoderDaemonConnected(false);
  proxiedAgentType = null;
  currentState = State.DISCONNECTED;
  currentOptions = [];
  broadcastStateUpdate();
});

function broadcastStateUpdate(): void {
  // Skip rendering while display is dimmed (Mac display asleep)
  if (isDisplayDimmed()) return;

  dlog('Plugin', `broadcast: state=${currentState} mode=${currentMode} opts=${currentOptions.length}`);

  // Encoder roles are per-action and the user places them; the takeover is the
  // one thing that overrides them, and only while the focused session holds for
  // an answer. Each refresh below self-gates on that, on daemon-down, and on
  // display sleep, so this stays a safe blanket repaint.
  repaintAllDials();
  // Keypad slots too — on display wake nothing else will repaint them, since
  // sessions_list only fires when the session set actually changes.
  refreshSessionSlots();
}

/** Repaint every encoder with its own content. Also how the takeover hands back. */
function repaintAllDials(): void {
  updateLauncherDialState();
  updateUtilityDialState(currentState);
  refreshClaudeUsageDial();
  refreshEffortDial();
  refreshAgentDial();
  refreshSessionDial();
  updateUsageDialState();
}

// ---- Register actions ----
streamDeck.actions.registerAction(new ResponseDialAction());
streamDeck.actions.registerAction(new LauncherDialAction());
streamDeck.actions.registerAction(new UtilityDialAction());
streamDeck.actions.registerAction(new UsageDialAction());
streamDeck.actions.registerAction(new EffortDialAction());
streamDeck.actions.registerAction(new SessionDialAction());
streamDeck.actions.registerAction(new AgentDialAction());
streamDeck.actions.registerAction(new SessionSlotButtonAction());

// ---- Slot Map Reporting (Phase A7) ----

// UUID suffix → actionType mapping
const UUID_TO_ACTION_TYPE: Record<string, string> = {
  'session-slot': 'session-slot',
  'response-dial': 'option-dial',
  'launcher': 'launcher',
  'utility-dial': 'utility-dial',
  'iterm-dial': 'iterm-dial',
};

interface SlotEntry {
  slot: number;
  controller: 'Keypad' | 'Encoder';
  actionType: string;
  settings?: Record<string, unknown>;
}

const appearedActions = new Map<string, SlotEntry>();
let slotMapTimer: ReturnType<typeof setTimeout> | null = null;

// Global willAppear listener — tracks all actions without modifying individual action files
streamDeck.actions.onWillAppear((ev) => {
  const uuid = ev.action.manifestId;
  const suffix = uuid.replace('bound.serendipity.agentdeck.', '');
  const actionType = UUID_TO_ACTION_TYPE[suffix] || suffix;
  const payload = ev.payload as any;
  const controller = payload.controller || 'Keypad';
  const column = payload.coordinates?.column ?? 0;
  const row = payload.coordinates?.row ?? 0;
  const device = (ev.action as any)?.device;
  const columns = Number(device?.size?.columns ?? 4);
  const keyColumns = Number.isFinite(columns) && columns > 0 ? columns : 4;

  appearedActions.set(ev.action.id, {
    slot: row * keyColumns + column,
    controller,
    actionType,
    settings: payload.settings,
  });

  // Debounce: wait for all actions to appear before sending
  if (slotMapTimer) clearTimeout(slotMapTimer);
  slotMapTimer = setTimeout(sendSlotMap, 500);

  // Sync state to newly appeared dial/button immediately
  broadcastStateUpdate();
});

function sendSlotMap(): void {
  const buttons: DeckSlotConfig[] = [];
  const encoders: DeckSlotConfig[] = [];

  for (const entry of appearedActions.values()) {
    const config: DeckSlotConfig = {
      slot: entry.slot,
      actionType: entry.actionType,
      settings: entry.settings,
    };
    if (entry.controller === 'Encoder') {
      encoders.push(config);
    } else {
      buttons.push(config);
    }
  }

  // Sort by slot
  buttons.sort((a, b) => a.slot - b.slot);
  encoders.sort((a, b) => a.slot - b.slot);

  const slotMap: DeckSlotMapEvent = {
    type: 'deck_slot_map',
    buttons,
    encoders,
  };

  dinfo('Plugin', `Sending slot map: ${buttons.length} buttons, ${encoders.length} encoders`);
  connMgr.send(slotMap as any);
}

// ---- Connect ----

streamDeck.connect().then(() => {
  dinfo('Plugin', 'Stream Deck connected, starting daemon-only connection');
  connMgr.start();

  // Auto-switch to the bundled profile that matches the physical key grid.
  // Each physical key grid needs its own bundled profile. SD+ has encoders,
  // classic has 15 keys, and Mini has a compact 3x2 keypad.
  //
  // SD+ profile was renamed from
  // `agentdeck-v4` → `agentdeck-sdplus` on 2026-04-20 because Elgato cached
  // the former as "dropped embedded profile" after an earlier bad package
  // install and refused to auto-install it thereafter. New name is treated
  // as fresh so AutoInstall fires cleanly.
  for (const device of streamDeck.devices) {
    const type = (device as any).type;
    const profile = type === 7
      ? 'agentdeck-sdplus'
      : type === 0
        ? 'agentdeck-sd'
        : type === 1
          ? 'agentdeck-sdmini'
          : null;
    if (!profile) continue;
    dinfo('Plugin', `Stream Deck device found: ${device.id} type=${type}, switching to ${profile}`);
    void streamDeck.profiles.switchToProfile(device.id, profile).catch((e: Error) => {
      dlog('Plugin', `profile switch failed (may already be active): ${e.message}`);
    });
  }
});
