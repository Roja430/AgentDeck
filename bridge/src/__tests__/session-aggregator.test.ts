import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enrichSessionsWithState,
  buildEnrichedSessionsList,
  clearSiblingStateCache,
  pendingPromptOf,
  updatePushState,
} from '../session-aggregator.js';
import type { SessionEntry } from '../session-registry.js';

vi.mock('../session-registry.js', () => ({
  listActive: vi.fn(() => []),
}));

// updatePushState fires a desktop notification on the transition into awaiting.
vi.mock('../desktop-notify.js', () => ({
  notifyAttention: vi.fn(),
  clearAttention: vi.fn(),
}));

import { listActive } from '../session-registry.js';

const mockListActive = vi.mocked(listActive);

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'session-1',
    port: 9121,
    pid: process.pid,
    projectName: 'AgentDeck',
    startedAt: new Date().toISOString(),
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('session-aggregator', () => {
  beforeEach(() => {
    mockListActive.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses ownState for the current session without fetching /health', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'own-session', port: 9125 })],
      'own-session',
      'processing',
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'own-session',
        port: 9125,
        projectName: 'AgentDeck',
        agentType: 'claude-code',
        alive: true,
        state: 'processing',
      }),
    ]);
  });

  it('fetches sibling /health and merges state and modelName', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ state: 'idle', modelName: 'opus-4' }),
    } as Response);

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9130, projectName: 'Backend' })],
      'own-session',
      'processing',
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9130/health',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'sibling',
        port: 9130,
        projectName: 'Backend',
        state: 'idle',
        modelName: 'opus-4',
      }),
    ]);
  });

  it('marks the session dead when sibling /health fails with no cache', async () => {
    clearSiblingStateCache('sibling');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect failed'));

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131, agentType: 'codex-cli' })],
      'own-session',
      'processing',
    );

    // No cached state to ride: an unreachable sibling is dead, so devices
    // (TRMNL e-ink, ESP32, Pixoo) prune it instead of showing it forever.
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'sibling',
        port: 9131,
        projectName: 'AgentDeck',
        alive: false,
        agentType: 'codex-cli',
      }),
    ]);
    expect(sessions[0].state).toBe('disconnected');
  });

  it('returns cached state when sibling /health fails after a previous success', async () => {
    clearSiblingStateCache('sibling');
    // First call succeeds — populates cache
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({ state: 'processing', modelName: 'gpt-5.4' }),
    } as Response);

    await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    // Second call fails — should use cached state
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    expect(sessions[0]).toEqual(expect.objectContaining({
      id: 'sibling',
      state: 'processing',
      modelName: 'gpt-5.4',
    }));
  });

  it('clearSiblingStateCache removes cached entry', async () => {
    // Populate cache
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({ state: 'idle', modelName: 'opus-4' }),
    } as Response);

    await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    // Clear cache then fail — no stale fallback, so the session is marked dead
    // (not left riding the now-cleared 'idle').
    clearSiblingStateCache('sibling');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling', port: 9131 })],
      'own-session',
      'idle',
    );

    expect(sessions[0].alive).toBe(false);
    expect(sessions[0].state).toBe('disconnected');
  });

  it('sweeps cached state for sessions that drop out of the active set', async () => {
    clearSiblingStateCache('sibling-a');
    clearSiblingStateCache('sibling-b');

    // 1. Populate cache for sibling-a via a successful /health.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      json: async () => ({ state: 'processing', modelName: 'opus-4' }),
    } as Response);
    await enrichSessionsWithState(
      [makeSession({ id: 'sibling-a', port: 9130 })],
      'own-session',
      'idle',
    );

    // 2. Enrich a list WITHOUT sibling-a — the sweep should evict its cache entry.
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      json: async () => ({ state: 'idle' }),
    } as Response);
    await enrichSessionsWithState(
      [makeSession({ id: 'sibling-b', port: 9131 })],
      'own-session',
      'idle',
    );

    // 3. sibling-a returns with a failing /health — cache was swept, so no stale
    // fallback: it's marked dead rather than riding the old 'processing'.
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('timeout'));
    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'sibling-a', port: 9130 })],
      'own-session',
      'idle',
    );

    expect(sessions[0].alive).toBe(false);
    expect(sessions[0].state).toBe('disconnected');
  });

  it('buildEnrichedSessionsList includes own session and excludes daemon', async () => {
    mockListActive.mockReturnValue([
      makeSession({ id: 'own-session', port: 9121, projectName: 'Main' }),
      makeSession({ id: 'daemon-1', port: 9120, projectName: 'Daemon', agentType: 'daemon' }),
      makeSession({ id: 'sibling-1', port: 9122, projectName: 'Backend' }),
      makeSession({ id: 'sibling-2', port: 9123, projectName: 'Frontend', agentType: 'codex-cli' }),
    ]);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(':9122/health')) {
        return { json: async () => ({ state: 'processing', modelName: 'opus-4' }) } as Response;
      }
      if (url.includes(':9123/health')) {
        return { json: async () => ({ state: 'idle', modelName: 'gpt-5.4' }) } as Response;
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const sessions = await buildEnrichedSessionsList('own-session', 'awaiting_option', 'opus-4', 'high');

    // Order from sortSessions: claude-code group sorted by projectName (Backend, Main)
    // then codex-cli group (Frontend). Daemon excluded.
    expect(sessions).toHaveLength(3);
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'sibling-1',
        projectName: 'Backend',
        state: 'processing',
        modelName: 'opus-4',
      }),
      expect.objectContaining({
        id: 'own-session',
        projectName: 'Main',
        state: 'awaiting_option',
        modelName: 'opus-4',
        effortLevel: 'high',
      }),
      expect.objectContaining({
        id: 'sibling-2',
        projectName: 'Frontend',
        state: 'idle',
        modelName: 'gpt-5.4',
        agentType: 'codex-cli',
      }),
    ]);
  });

  it('buildEnrichedSessionsList returns own session in single-session mode without /health calls', async () => {
    // single-session mode: only the own session is registered (no daemon, no siblings).
    // This is the `agentdeck claude` standalone case where session-slot buttons would
    // otherwise stay "Empty" because the aggregator returned [].
    mockListActive.mockReturnValue([
      makeSession({ id: 'own-session', port: 9121, projectName: 'Solo' }),
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const sessions = await buildEnrichedSessionsList('own-session', 'idle', 'opus-4');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({
      id: 'own-session',
      projectName: 'Solo',
      state: 'idle',
      modelName: 'opus-4',
    }));
  });
});

/**
 * A prompt is state, not just an event.
 *
 * The Stream Deck takeover never engaged for a session whose prompt predated
 * the deck's focus: the relay only forwards events, and a session parked at an
 * unanswered prompt emits none. `sessions_list` has to answer "what is this
 * session waiting for" on its own.
 */
describe('pending prompt on the session list', () => {
  const options = [
    { index: 0, label: 'Yes' },
    { index: 1, label: 'No' },
  ];

  beforeEach(() => {
    mockListActive.mockReset();
    vi.restoreAllMocks();
    clearSiblingStateCache('waiting');
  });

  it('carries the prompt pushed by a session bridge', async () => {
    updatePushState('waiting', 'awaiting_permission', 'opus-5', 'high', {
      question: 'Overwrite test.txt?',
      options,
      promptType: 'yes_no',
    });

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'waiting', port: 9131 })],
      'own-session',
      'idle',
    );

    expect(sessions[0]).toEqual(expect.objectContaining({
      state: 'awaiting_permission',
      question: 'Overwrite test.txt?',
      options,
      promptType: 'yes_no',
    }));
  });

  it('carries the prompt from /health once the push cache goes stale', async () => {
    // The push channel only fires on change, so a session sitting at the same
    // prompt for over 30s falls back to polling — which must not lose the
    // options, or the prompt becomes unanswerable from any device.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        state: 'awaiting_option',
        question: 'Which one?',
        options,
        promptType: 'multi_select',
      }),
    } as Response);

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'polled', port: 9132 })],
      'own-session',
      'idle',
    );

    expect(sessions[0]).toEqual(expect.objectContaining({
      question: 'Which one?',
      options,
      promptType: 'multi_select',
    }));
  });

  it('drops the prompt once the session answers it', async () => {
    updatePushState('waiting', 'awaiting_permission', undefined, undefined, {
      question: 'Overwrite test.txt?',
      options,
      promptType: 'yes_no',
    });
    updatePushState('waiting', 'processing');

    const sessions = await enrichSessionsWithState(
      [makeSession({ id: 'waiting', port: 9131 })],
      'own-session',
      'idle',
    );

    expect(sessions[0].question).toBeUndefined();
    expect(sessions[0].options).toBeUndefined();
  });

  it('reports the own session\u2019s prompt in single-session mode', async () => {
    mockListActive.mockReturnValue([makeSession({ id: 'own-session', port: 9121 })]);

    const sessions = await buildEnrichedSessionsList(
      'own-session',
      'awaiting_option',
      undefined,
      undefined,
      { question: 'Which one?', options, promptType: 'multi_select' },
    );

    expect(sessions[0]).toEqual(expect.objectContaining({ question: 'Which one?', options }));
  });
});

describe('pendingPromptOf', () => {
  it('reports nothing when the agent is not waiting on a choice', () => {
    expect(pendingPromptOf({ state: 'processing', options: [] })).toEqual({});
  });

  it('classifies a two-way permission prompt as yes_no', () => {
    const p = pendingPromptOf({
      state: 'awaiting_permission',
      question: 'Allow?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    });
    expect(p.promptType).toBe('yes_no');
  });

  it('classifies a permission prompt with an "allow all" row as yes_no_always', () => {
    const p = pendingPromptOf({
      state: 'awaiting_permission',
      options: [
        { index: 0, label: 'Yes' },
        { index: 1, label: 'Yes, allow all edits' },
        { index: 2, label: 'No' },
      ],
    });
    expect(p.promptType).toBe('yes_no_always');
  });

  it('classifies a diff review as diff_review', () => {
    const p = pendingPromptOf({ state: 'awaiting_diff', options: [{ index: 0, label: 'Accept' }] });
    expect(p.promptType).toBe('diff_review');
  });
});
