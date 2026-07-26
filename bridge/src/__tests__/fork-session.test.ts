import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import {
  buildAgentCommand,
  buildWindowsTerminalArgs,
  isForkableSessionId,
  launchSession,
} from '../session-launcher.js';

const UUID = '3f2b1c8a-9d4e-4f10-8a7b-1c2d3e4f5a6b';

describe('buildAgentCommand', () => {
  it('resumes and branches when forking', () => {
    expect(buildAgentCommand({ agent: 'claude', cwd: 'C:\\x', forkFrom: UUID }))
      .toBe(`claude --resume ${UUID} --fork-session`);
  });

  it('calls claude directly rather than through the CLI wrapper', () => {
    // The hooks are installed globally, so the fork is picked up as an observed
    // session on its own; routing it through `agentdeck claude` would wrap it in
    // a managed PTY the fork does not need.
    const cmd = buildAgentCommand({ agent: 'claude', cwd: 'C:\\x', forkFrom: UUID });
    expect(cmd.startsWith('claude ')).toBe(true);
    expect(cmd).not.toContain('agentdeck');
  });

  it('starts a fresh session when not forking', () => {
    expect(buildAgentCommand({ agent: 'codex', cwd: 'C:\\x' })).toBe('agentdeck codex');
  });

  it('carries the fork command into the terminal argv', () => {
    const args = buildWindowsTerminalArgs({ agent: 'claude', cwd: 'C:\\Users\\me\\Claude Code', forkFrom: UUID });
    expect(args[1]).toBe('C:\\Users\\me\\Claude Code'); // still its own argv entry
    expect(args.at(-1)).toBe(`claude --resume ${UUID} --fork-session`);
  });
});

describe('isForkableSessionId', () => {
  it('accepts a Claude session uuid', () => {
    expect(isForkableSessionId(UUID)).toBe(true);
  });

  it('rejects anything that could smuggle an argument past --resume', () => {
    // The id reaches a command line, so this is the boundary that matters.
    expect(isForkableSessionId(`${UUID} --allow-dangerously-skip-permissions`)).toBe(false);
    expect(isForkableSessionId('../../etc/passwd')).toBe(false);
    expect(isForkableSessionId('a; rm -rf /')).toBe(false);
    expect(isForkableSessionId('')).toBe(false);
  });
});

describe('launchSession fork validation', () => {
  it('refuses a malformed session id without spawning', () => {
    const res = launchSession({ agent: 'claude', cwd: tmpdir(), forkFrom: 'not a uuid; whoami' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Invalid session id');
  });

  it('still refuses a missing folder when forking', () => {
    const res = launchSession({ agent: 'claude', cwd: '/definitely/not/here', forkFrom: UUID });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Project folder is gone');
  });

  it('does not apply the launchable-agent list to a fork', () => {
    // A fork always runs claude, so the agent field is irrelevant — it must not
    // be the thing that rejects the request.
    const res = launchSession({ agent: 'whatever', cwd: '/definitely/not/here', forkFrom: UUID });
    expect(res.error).not.toContain('Unknown agent');
  });
});
