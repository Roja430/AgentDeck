/**
 * Start a new agent session in a chosen directory.
 *
 * The session has to land in a terminal the user can read: `agentdeck claude`
 * runs the agent in a PTY the bridge steers, but the conversation itself is
 * still text on a screen, and the deck cannot render it.
 *
 * Windows Terminal is the only launcher used on Windows. It is the default
 * terminal on Windows 11 and it is the one path verified to carry a working
 * directory containing spaces intact. A `cmd /c start` fallback was tried and
 * did not reliably run the command, so rather than shipping an unverified
 * second path this reports a clear error when `wt` is absent — a launch that
 * silently does nothing is worse than one that says why.
 */
import { spawn } from './proc.js';
import { existsSync } from 'fs';
import { debug } from './logger.js';

export interface LaunchRequest {
  /** CLI subcommand — `agentdeck claude`, `agentdeck codex`, … */
  agent: string;
  /** Absolute directory to start the session in. */
  cwd: string;
}

export interface LaunchResult {
  ok: boolean;
  /** Present when ok is false — shown on the deck, so keep it short. */
  error?: string;
}

/** Agents the CLI actually has a subcommand for. */
const LAUNCHABLE = new Set(['claude', 'codex', 'opencode']);

export function isLaunchableAgent(agent: string): boolean {
  return LAUNCHABLE.has(agent);
}

/**
 * Build the Windows Terminal argv.
 *
 * Passed as separate argv entries rather than a command string: `-d` takes the
 * directory as its own argument, which is what keeps a path like
 * `C:\Users\me\Claude Code` from being split on the space.
 */
export function buildWindowsTerminalArgs(req: LaunchRequest): string[] {
  return ['-d', req.cwd, 'cmd.exe', '/k', `agentdeck ${req.agent}`];
}

/** macOS/Linux: hand the whole thing to the platform's terminal opener. */
export function buildPosixLaunch(req: LaunchRequest): { file: string; args: string[] } {
  if (process.platform === 'darwin') {
    // `open -a Terminal <dir>` opens at the directory but cannot carry a
    // command, so the command is written as an AppleScript instead.
    const script = `tell application "Terminal" to do script "cd ${JSON.stringify(req.cwd)} && agentdeck ${req.agent}"`;
    return { file: 'osascript', args: ['-e', script] };
  }
  return { file: 'x-terminal-emulator', args: ['-e', `agentdeck ${req.agent}`] };
}

export function launchSession(req: LaunchRequest): LaunchResult {
  if (!isLaunchableAgent(req.agent)) {
    return { ok: false, error: `Unknown agent: ${req.agent}` };
  }
  if (!req.cwd || !existsSync(req.cwd)) {
    return { ok: false, error: 'Project folder is gone' };
  }

  try {
    let file: string;
    let args: string[];
    if (process.platform === 'win32') {
      file = 'wt.exe';
      args = buildWindowsTerminalArgs(req);
    } else {
      ({ file, args } = buildPosixLaunch(req));
    }

    // windowsHide: false is deliberate and is the one place in the bridge that
    // wants it — proc.ts hides consoles by default precisely because everything
    // else spawns invisible helpers, but here the terminal *is* the deliverable.
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    let failed: string | undefined;
    child.on('error', (err) => {
      failed = err.message;
      debug('Launcher', `launch failed: ${err.message}`);
    });
    child.unref?.();

    debug('Launcher', `launched ${req.agent} in ${req.cwd}`);
    return failed ? { ok: false, error: failed } : { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT on Windows means Windows Terminal is not installed.
    const friendly = process.platform === 'win32' && /ENOENT/.test(message)
      ? 'Windows Terminal not found'
      : message;
    return { ok: false, error: friendly };
  }
}
