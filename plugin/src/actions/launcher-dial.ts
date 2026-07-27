/**
 * E4 — Launcher dial (Stream Deck+).
 *
 * Rotate rolls through the configured agents; press opens that agent's app or
 * web UI. The list is static and depends on no daemon state, so the dial behaves
 * identically on a fresh install and on a fully wired setup.
 *
 * This encoder replaced the push-to-talk Voice dial ahead of the Marketplace
 * submission. Voice recording depended on borrowing iTerm2's microphone grant
 * via AppleScript plus Homebrew `sox` and a local whisper model — none of which
 * a reviewer (or a typical user) has, so it failed silently on a clean machine.
 * Launching an app is the same interaction shape with none of that fragility.
 *
 * A "focus the live session" tier was prototyped and dropped: the daemon knows a
 * session's port and cwd but not which terminal window renders it, so focusing
 * meant substring-matching iTerm2 session names against project names — which
 * silently activates the wrong window whenever two projects share a name prefix.
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import {
  encoderRegistry,
  isDaemonConnected,
  rememberEncoderColumn,
  forgetEncoderColumn,
} from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderLauncher, renderLauncherEmpty, type LauncherRenderData } from '../renderers/launcher-renderer.js';
import { paintOfflineBanner } from '../offline-banner.js';
import { dlog, dinfo, dwarn } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/macos.js';
import { buildEntriesWithProjects, rollIndex, runTarget } from '../launch-targets.js';

import type { JsonValue } from '@elgato/utils';
import {
  isTakeoverActive,
  handleTakeoverRotate,
  handleTakeoverPress,
} from '../encoder-takeover.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

interface LauncherSettings {
  [key: string]: JsonValue;
  claudeTarget?: string;
  codexTarget?: string;
  openclawTarget?: string;
}

let settings: LauncherSettings = {};
/** Launch targets from the daemon — see updateLauncherProjects(). */
let recentProjects: { path: string; name: string }[] = [];
/** Sends a daemon command; injected so this file needs no link import. */
let sendCommand: ((c: { type: string; [k: string]: unknown }) => void) | null = null;
let index = 0;
let currentLayout = '';

function entries() {
  return buildEntriesWithProjects(settings, recentProjects);
}

/** Called from plugin.ts on sessions_list — the daemon owns this list. */
export function updateLauncherProjects(list: { path: string; name: string }[]): void {
  recentProjects = list;
  refreshLauncherDials();
}

export function initLauncherDial(send?: (c: { type: string; [k: string]: unknown }) => void): void {
  dinfo('Launcher', 'initLauncherDial');
  sendCommand = send ?? null;
  refreshLauncherDials();
}

export function updateLauncherDialState(): void {
  currentLayout = '';
  refreshLauncherDials();
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.launcherIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

export function refreshLauncherDials(): void {
  if (isDisplayDimmed()) return;
  if (isTakeoverActive()) return;
  if (!isDaemonConnected()) {
    ensurePixmapLayout();
    paintOfflineBanner(encoderRegistry.launcherIds);
    return;
  }

  ensurePixmapLayout();

  const list = entries();
  let svg: string;
  if (list.length === 0) {
    svg = renderLauncherEmpty();
  } else {
    const pos = Math.min(index, list.length - 1);
    const data: LauncherRenderData = {
      label: list[pos].label,
      detail: 'Open',
      position: pos + 1,
      total: list.length,
    };
    svg = renderLauncher(data);
  }

  const canvasFeedback = { canvas: svgToDataUrl(svg) };
  for (const id of encoderRegistry.launcherIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(canvasFeedback).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.launcher' })
export class LauncherDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.launcherIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('Launcher', `onWillAppear: id=${ev.action.id} controller=${ev.payload.controller}`);
    if (!encoderRegistry.launcherIds.includes(ev.action.id)) {
      encoderRegistry.launcherIds.push(ev.action.id);
    }
    rememberEncoderColumn(ev.action.id, (ev.payload as any).coordinates?.column);
    settings = (ev.payload?.settings ?? {}) as LauncherSettings;
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refreshLauncherDials();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<LauncherSettings>): void {
    settings = ev.payload.settings;
    refreshLauncherDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (!isDaemonConnected()) return;

    const list = entries();
    if (list.length === 0) return;
    // Wrap in both directions so a long roll never dead-ends.
    index = rollIndex(index, ev.payload.ticks, list.length);
    dlog('Launcher', `rotate: idx=${index}/${list.length}`);
    refreshLauncherDials();
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    if (isTakeoverActive()) { handleTakeoverPress(); return; }
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }

    const list = entries();
    if (list.length === 0) return;
    const entry = list[Math.min(index, list.length - 1)];

    try {
      if (entry.newSession) {
        // Starting a session needs a terminal, which only the daemon can open.
        dlog('Launcher', `new_session ${entry.newSession.agent} in ${entry.newSession.cwd}`);
        sendCommand?.({ type: 'new_session', ...entry.newSession });
        refreshLauncherDials();
        return;
      }
      dlog('Launcher', `launch ${entry.agent}: ${entry.target}`);
      await runTarget(entry.target);
    } catch (err) {
      // A missing app or an unreachable URL must not be a silent no-op.
      dwarn('Launcher', `press failed: ${err}`);
      void (ev.action as any).showAlert?.().catch(() => {});
    }
    refreshLauncherDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    forgetEncoderColumn(ev.action.id);
    const idx = encoderRegistry.launcherIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.launcherIds.splice(idx, 1);
    }
  }
}