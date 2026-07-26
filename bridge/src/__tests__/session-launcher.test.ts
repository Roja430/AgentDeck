import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import {
  buildWindowsTerminalArgs,
  cleanAgentEnv,
  isLaunchableAgent,
  launchSession,
} from '../session-launcher.js';

describe('cleanAgentEnv', () => {
  // The daemon is often started from inside a Claude Code session. A launched
  // agent inheriting CLAUDE_CODE_CHILD_SESSION decides it is a nested run and
  // stops writing a transcript — which is the only thing the deck can observe,
  // so the session looks launched and is invisible.
  it('drops the parent session identity', () => {
    const out = cleanAgentEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_HOST_SESSION_ID: 'def',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    });
    expect(Object.keys(out)).toEqual([]);
  });

  it('keeps user configuration and unrelated variables', () => {
    const out = cleanAgentEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_API_BASE_URL: 'https://example.test',
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CODE_API_BASE_URL: 'https://example.test',
      CLAUDE_CODE_DISABLE_CRON: '1',
    });
  });

  it('does not mutate the environment it was given', () => {
    const src = { CLAUDE_CODE_CHILD_SESSION: '1' };
    cleanAgentEnv(src);
    expect(src.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });
});

describe('buildWindowsTerminalArgs', () => {
  it('passes the directory as its own argument so spaces survive', () => {
    // A command string would split `Claude Code` — this is the whole reason
    // Windows Terminal is invoked with an argv array rather than a shell line.
    const args = buildWindowsTerminalArgs({ agent: 'claude', cwd: 'C:\\Users\\me\\Claude Code' });
    expect(args[0]).toBe('-d');
    expect(args[1]).toBe('C:\\Users\\me\\Claude Code');
  });

  it('runs the agent through the CLI and keeps the shell open', () => {
    const args = buildWindowsTerminalArgs({ agent: 'codex', cwd: 'C:\\x' });
    // /k, not /c: the session must outlive the command that started it.
    expect(args).toContain('/k');
    expect(args.at(-1)).toBe('agentdeck codex');
  });
});

describe('isLaunchableAgent', () => {
  it('accepts the agents the CLI has subcommands for', () => {
    expect(isLaunchableAgent('claude')).toBe(true);
    expect(isLaunchableAgent('codex')).toBe(true);
    expect(isLaunchableAgent('opencode')).toBe(true);
  });

  it('rejects anything else rather than shelling out blindly', () => {
    // The agent name reaches a command line, so an unknown value must not pass.
    expect(isLaunchableAgent('openclaw')).toBe(false);
    expect(isLaunchableAgent('rm -rf /')).toBe(false);
    expect(isLaunchableAgent('')).toBe(false);
  });
});

describe('launchSession validation', () => {
  it('refuses an unknown agent without spawning', () => {
    const res = launchSession({ agent: 'bogus', cwd: tmpdir() });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown agent');
  });

  it('refuses a directory that no longer exists', () => {
    // Recent projects come from history, so the folder may have been deleted.
    const res = launchSession({ agent: 'claude', cwd: '/definitely/not/here/at/all' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Project folder is gone');
  });

  it('refuses an empty cwd instead of inheriting the daemon working directory', () => {
    const res = launchSession({ agent: 'claude', cwd: '' });
    expect(res.ok).toBe(false);
  });
});
