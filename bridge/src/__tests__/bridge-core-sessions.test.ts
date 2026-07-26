import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeCore } from '../bridge-core.js';
import { createTempDataDir, type TempDataDir } from './helpers/temp-data-dir.js';

vi.mock('../session-aggregator.js', () => ({
  buildEnrichedSessionsList: vi.fn(),
}));

import { buildEnrichedSessionsList } from '../session-aggregator.js';

const mockBuildEnrichedSessionsList = vi.mocked(buildEnrichedSessionsList);

describe('BridgeCore sessions_list', () => {
  let core: BridgeCore;
  let httpServer: ReturnType<typeof createServer>;
  let tempDir: TempDataDir;
  let claudeHome: string;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    // sessions_list now carries recentProjects, which are scanned from Claude
    // Code's transcript history. Point that at an empty directory so the test
    // asserts on its own fixtures instead of whatever the developer's machine
    // happens to have worked on.
    claudeHome = mkdtempSync(join(tmpdir(), 'agentdeck-core-claude-'));
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    tempDir = createTempDataDir();
    httpServer = createServer();
    core = new BridgeCore({
      port: 9121,
      projectName: 'TestProject',
      httpServer,
    });
    mockBuildEnrichedSessionsList.mockReset();
  });

  afterEach(() => {
    core.wsServer.close();
    core.displayMonitor.stop();
    httpServer.close();
    tempDir.cleanup();
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    rmSync(claudeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('broadcastSessionsList enriches sessions before broadcast', async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([
      {
        id: 'sibling-1',
        port: 9122,
        projectName: 'Backend',
        alive: true,
        state: 'idle',
        agentType: 'codex-cli',
        modelName: 'gpt-5.4',
      },
    ]);

    core.setSessionsEnricher((sessions) => sessions.map((session) => ({
      ...session,
      projectName: `${session.projectName} [visible]`,
    })));

    const broadcastSpy = vi.spyOn(core.wsServer, 'broadcast').mockImplementation(() => {});
    core.stateMachine.handleHookEvent('SessionStart', {});

    await core.broadcastSessionsList();

    expect(mockBuildEnrichedSessionsList).toHaveBeenCalledWith(core.sessionId, 'idle', undefined, undefined);
    // objectContaining on the envelope too: the event grows fields over time and
    // an exact match makes every addition look like a regression here.
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sessions_list',
      sessions: [
        expect.objectContaining({
          id: 'sibling-1',
          projectName: 'Backend [visible]',
          state: 'idle',
          modelName: 'gpt-5.4',
          agentType: 'codex-cli',
        }),
      ],
    }));
  });

  it('sendInitialState sends enriched sessions_list to the connecting client', async () => {
    mockBuildEnrichedSessionsList.mockResolvedValue([
      {
        id: 'sibling-2',
        port: 9123,
        projectName: 'Frontend',
        alive: true,
        state: 'processing',
        agentType: 'claude-code',
        modelName: 'opus-4',
      },
    ]);

    core.setSessionsEnricher((sessions) => [
      ...sessions,
      {
        id: 'openclaw-gateway',
        port: 18789,
        projectName: 'OpenClaw',
        alive: true,
        state: 'idle',
        agentType: 'openclaw',
      },
    ]);

    const sentEvents: Array<Record<string, unknown>> = [];
    vi.spyOn(core.wsServer, 'sendTo').mockImplementation((_ws, evt) => {
      sentEvents.push(evt as Record<string, unknown>);
    });
    const ws = { readyState: 1, send: vi.fn() } as any;

    core.stateMachine.handleHookEvent('SessionStart', {});
    core.sendInitialState(ws, {
      agentType: 'claude-code',
      isAlive: true,
    });

    await vi.waitFor(() => {
      const sessionsEvent = sentEvents.find((evt) => evt.type === 'sessions_list');
      expect(sessionsEvent).toBeDefined();
      expect((sessionsEvent as any).sessions).toEqual([
        expect.objectContaining({
          id: 'sibling-2',
          projectName: 'Frontend',
          state: 'processing',
          modelName: 'opus-4',
        }),
        expect.objectContaining({
          id: 'openclaw-gateway',
          projectName: 'OpenClaw',
          agentType: 'openclaw',
          state: 'idle',
        }),
      ]);
    });

    expect(mockBuildEnrichedSessionsList).toHaveBeenCalledWith(core.sessionId, 'idle', undefined, undefined);
  });
});
