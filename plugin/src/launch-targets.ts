/**
 * Launch-target resolution for the E4 Launcher dial.
 *
 * Kept out of the action module on purpose: action files carry the `@action`
 * decorator, which the test runner cannot parse, so anything that lives beside
 * it is effectively untestable. This is the part with real branching, so it
 * lives here where it can be covered directly.
 */
import { OPENCLAW_GATEWAY_PORT } from '@agentdeck/shared';
import { openDesktopApp, openWebUrl } from './utility-modes/desktop.js';
import { dlog } from './log.js';

const TAG = 'Launcher';

/**
 * A launch target is a `|`-separated fallback chain, each step either a desktop
 * app (`app:Claude`) or a URL (`url:https://…`). The chain matters because the
 * desktop app is the better destination when installed but cannot be assumed:
 * `app:Codex|url:https://chatgpt.com/codex/cloud` opens the app for users who
 * have it and the web console for everyone else, with no per-user setup.
 */
export const DEFAULT_TARGETS: Record<string, string> = {
  claude: 'app:Claude|url:https://claude.ai',
  codex: 'app:Codex|url:https://chatgpt.com/codex/cloud',
  openclaw: `url:http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`,
};

export const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  openclaw: 'OpenClaw',
};

export interface LaunchEntry {
  label: string;
  agent: string;
  target: string;
  /**
   * Set on "new task" entries. The dial sends a `new_session` command for these
   * instead of walking `target`, because starting a session is the daemon's job
   * — the plugin has no terminal to open one in.
   */
  newSession?: { agent: string; cwd: string };
}

/** Agent a "new task" entry starts. Only Claude Code has a keypad presence. */
const NEW_SESSION_AGENT = 'claude';

/**
 * Append one "new task" entry per recent project.
 *
 * They come after the plain agent entries so the existing roll order is
 * unchanged for anyone who has muscle memory for it, and the list stays empty
 * when there is no history rather than showing a dead entry.
 */
export function buildEntriesWithProjects(
  overrides: Record<string, unknown> = {},
  recentProjects: { path: string; name: string }[] = [],
): LaunchEntry[] {
  const base = buildEntries(overrides);
  const news = recentProjects.map((p) => ({
    label: `New · ${p.name}`,
    agent: NEW_SESSION_AGENT,
    target: '',
    newSession: { agent: NEW_SESSION_AGENT, cwd: p.path },
  }));
  return [...base, ...news];
}

/** Resolve the effective target for an agent, honouring a user override. */
export function resolveTarget(agent: string, override: unknown): string {
  return (typeof override === 'string' && override.trim())
    ? override.trim()
    : DEFAULT_TARGETS[agent];
}

/** The rolling list, in display order. */
export function buildEntries(overrides: Record<string, unknown> = {}): LaunchEntry[] {
  return Object.keys(DEFAULT_TARGETS).map(agent => ({
    label: AGENT_LABELS[agent],
    agent,
    target: resolveTarget(agent, overrides[`${agent}Target`]),
  }));
}

/** Wrap the rolling index in both directions so a long roll never dead-ends. */
export function rollIndex(index: number, ticks: number, total: number): number {
  if (total <= 0) return 0;
  return (((index + ticks) % total) + total) % total;
}

async function runStep(step: string): Promise<void> {
  if (step.startsWith('url:')) {
    await openWebUrl(step.slice(4));
    return;
  }
  if (step.startsWith('app:')) {
    await openDesktopApp(step.slice(4));
    return;
  }
  throw new Error(`Unrecognized launch target: ${step}`);
}

/** Walk the fallback chain, surfacing the LAST failure if every step fails. */
export async function runTarget(target: string): Promise<void> {
  const steps = target.split('|').map(t => t.trim()).filter(Boolean);
  if (steps.length === 0) throw new Error('Empty launch target');

  let lastErr: unknown;
  for (const step of steps) {
    try {
      await runStep(step);
      return;
    } catch (err) {
      dlog(TAG, `step failed (${step}), trying next: ${err}`);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
