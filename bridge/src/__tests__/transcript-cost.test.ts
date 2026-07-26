import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cacheHitRatio,
  getCachedCostSummary,
  refreshCostSummary,
  resetCostCache,
  scanTranscriptCosts,
  toCostSummary,
} from '../transcript-cost.js';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const DAY = 86_400_000;

interface TurnOptions {
  id: string;
  requestId?: string;
  ts: number;
  model?: string;
  sessionId?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
}

function assistantTurn(o: TurnOptions): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(o.ts).toISOString(),
    requestId: o.requestId ?? `req_${o.id}`,
    sessionId: o.sessionId ?? 'sess-1',
    message: {
      id: o.id,
      model: o.model ?? 'claude-opus-5',
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_creation_input_tokens: o.cacheCreation ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
      },
    },
  });
}

describe('scanTranscriptCosts', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentdeck-transcripts-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a transcript and set its mtime, which is what the window filter reads. */
  function writeTranscript(project: string, file: string, lines: string[], mtimeMs = NOW): void {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  }

  function scan(windowDays?: number) {
    return scanTranscriptCosts({ dir: root, now: NOW, windowDays });
  }

  it('prices input, output, cache writes and cache reads', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      assistantTurn({
        id: 'msg1',
        ts: NOW - 3600_000,
        model: 'claude-opus-5',
        input: 1_000_000,
        output: 1_000_000,
        cacheCreation: 1_000_000,
        cacheRead: 1_000_000,
      }),
    ]);

    const report = scan();
    // Opus 5 is $5 in / $25 out; cache write 1.25x input, cache read 0.1x input.
    expect(report.total.costUsd).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
    expect(report.total.calls).toBe(1);
    expect(report.filesScanned).toBe(1);
  });

  it('charges cache reads at a tenth of the input rate, not the full rate', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      assistantTurn({ id: 'msg1', ts: NOW, model: 'claude-opus-5', cacheRead: 1_000_000 }),
    ]);
    // The whole point of cache-aware pricing: $0.50, not $5.
    expect(scan().total.costUsd).toBeCloseTo(0.5, 6);
  });

  it('deduplicates a turn that appears in two transcripts', () => {
    const turn = assistantTurn({ id: 'msg1', ts: NOW, output: 1_000_000 });
    writeTranscript('proj-a', 's1.jsonl', [turn]);
    writeTranscript('proj-a', 's2-resumed.jsonl', [turn]);

    const report = scan();
    expect(report.filesScanned).toBe(2);
    expect(report.total.calls).toBe(1);
    expect(report.total.costUsd).toBeCloseTo(25, 6);
  });

  it('counts retries of the same turn separately', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      assistantTurn({ id: 'msg1', requestId: 'req_a', ts: NOW, output: 1000 }),
      assistantTurn({ id: 'msg1', requestId: 'req_b', ts: NOW, output: 1000 }),
    ]);
    expect(scan().total.calls).toBe(2);
  });

  it('buckets by today, 7 days and 30 days', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      assistantTurn({ id: 'today', ts: NOW - 3600_000, output: 1_000_000 }),
      assistantTurn({ id: 'threeDays', ts: NOW - 3 * DAY, output: 1_000_000 }),
      assistantTurn({ id: 'twentyDays', ts: NOW - 20 * DAY, output: 1_000_000 }),
    ]);

    const report = scan();
    expect(report.today.calls).toBe(1);
    expect(report.last7Days.calls).toBe(2);
    expect(report.last30Days.calls).toBe(3);
    expect(report.total.calls).toBe(3);
  });

  it('excludes records older than the window', () => {
    writeTranscript('proj-a', 'old.jsonl', [
      assistantTurn({ id: 'ancient', ts: NOW - 60 * DAY, output: 1_000_000 }),
    ]);
    expect(scan(30).total.calls).toBe(0);
  });

  it('skips transcripts whose last write predates the window', () => {
    writeTranscript(
      'proj-a',
      'stale.jsonl',
      [assistantTurn({ id: 'old', ts: NOW - 40 * DAY, output: 1000 })],
      NOW - 40 * DAY,
    );
    expect(scan(30).filesScanned).toBe(0);
  });

  it('splits totals by model and by session', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      assistantTurn({ id: 'a', ts: NOW - 2000, model: 'claude-opus-5', sessionId: 'sess-1', output: 1_000_000 }),
      assistantTurn({ id: 'b', ts: NOW - 1000, model: 'claude-haiku-4-5', sessionId: 'sess-2', output: 1_000_000 }),
    ]);

    const report = scan();
    expect(report.byModel['claude-opus-5'].costUsd).toBeCloseTo(25, 6);
    expect(report.byModel['claude-haiku-4-5'].costUsd).toBeCloseTo(5, 6);
    expect(report.sessions.map((s) => s.sessionId)).toEqual(['sess-2', 'sess-1']);
    expect(report.sessions[0].project).toBe('proj-a');
  });

  it('flags models missing from the pricing table', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      assistantTurn({ id: 'a', ts: NOW, model: 'claude-from-the-future', output: 1_000_000 }),
    ]);

    const report = scan();
    expect(report.unpricedModels).toEqual(['claude-from-the-future']);
    expect(report.total.costUsd).toBe(0);
    expect(report.total.outputTokens).toBe(1_000_000); // tokens still counted
  });

  it('ignores non-assistant rows and a torn trailing line', () => {
    writeTranscript('proj-a', 's1.jsonl', [
      JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString() }),
      assistantTurn({ id: 'a', ts: NOW, output: 1000 }),
      '{"type":"assistant","message":{"usage":{"outp',
    ]);
    expect(scan().total.calls).toBe(1);
  });

  it('returns an empty report when the projects directory is absent', () => {
    const report = scanTranscriptCosts({ dir: join(root, 'nope'), now: NOW });
    expect(report.filesScanned).toBe(0);
    expect(report.total.costUsd).toBe(0);
    expect(report.sessions).toEqual([]);
  });
});

describe('toCostSummary', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentdeck-summary-'));
    resetCostCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetCostCache();
  });

  function write(lines: string[]): void {
    const dir = join(root, 'proj-a');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 's1.jsonl');
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
    utimesSync(path, new Date(NOW), new Date(NOW));
  }

  it('ranks models by cost, highest first, and caps the list at 5', () => {
    write(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
        assistantTurn({ id, ts: NOW, model: `model-${i}`, output: 1000 }),
      ),
    );
    // Real rates so the ordering is meaningful.
    write([
      assistantTurn({ id: 'x', ts: NOW, model: 'claude-haiku-4-5', output: 1_000_000 }),
      assistantTurn({ id: 'y', ts: NOW, model: 'claude-opus-5', output: 1_000_000 }),
      assistantTurn({ id: 'z', ts: NOW, model: 'claude-sonnet-5', output: 1_000_000 }),
    ]);

    const summary = toCostSummary(scanTranscriptCosts({ dir: root, now: NOW }), NOW);
    expect(summary.byModel.map((m) => m.model)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(summary.byModel.length).toBeLessThanOrEqual(5);
  });

  it('omits unpricedModels entirely when every model is priced', () => {
    write([assistantTurn({ id: 'a', ts: NOW, output: 1000 })]);
    expect(toCostSummary(scanTranscriptCosts({ dir: root, now: NOW }), NOW).unpricedModels).toBeUndefined();
  });

  it('carries the 30-day cache hit ratio', () => {
    write([assistantTurn({ id: 'a', ts: NOW, input: 200, cacheRead: 800 })]);
    const summary = toCostSummary(scanTranscriptCosts({ dir: root, now: NOW }), NOW);
    expect(summary.cacheHitRatio).toBeCloseTo(0.8, 6);
  });
});

describe('refreshCostSummary throttling', () => {
  beforeEach(() => resetCostCache());
  afterEach(() => resetCostCache());

  it('returns null before the first scan', () => {
    expect(getCachedCostSummary()).toBeNull();
  });

  it('reuses the cached summary inside the interval', () => {
    const first = refreshCostSummary(60_000);
    const second = refreshCostSummary(60_000);
    expect(second).toBe(first); // same object — no rescan
    expect(getCachedCostSummary()).toBe(first);
  });

  it('rescans once the interval has elapsed', () => {
    const first = refreshCostSummary(60_000);
    const second = refreshCostSummary(0); // interval elapsed
    expect(second).not.toBe(first);
  });
});

describe('cacheHitRatio', () => {
  it('is the cache-read share of all input tokens', () => {
    const ratio = cacheHitRatio({
      calls: 1,
      inputTokens: 100,
      outputTokens: 999,
      cacheCreationTokens: 100,
      cacheReadTokens: 800,
      costUsd: 0,
    });
    expect(ratio).toBeCloseTo(0.8, 6);
  });

  it('is null when there is no input at all', () => {
    expect(cacheHitRatio({ calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 })).toBeNull();
  });
});
