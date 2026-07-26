/**
 * Local cost aggregation from Claude Code transcripts.
 *
 * The OAuth usage API (`usage-api.ts`) reports subscription *quota* — how much
 * of the 5h/7d window is spent — but never dollars. This module derives the
 * dollar figure the quota gauges can't show, by pricing the token counts Claude
 * Code already writes to `~/.claude/projects/<slug>/<session>.jsonl`.
 *
 * It works offline, needs no credentials, and answers "what would this have
 * cost on the API" for subscription users. It is an *estimate*: list prices,
 * no discounts, no per-org contract rates.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { budgetStateFor, isPricedModel, loadCostSettings, priceUsdWithCache } from '@agentdeck/shared';
import type { TranscriptCostSummary } from '@agentdeck/shared';
import { debug } from './logger.js';

/** Claude Code config dir — `CLAUDE_CONFIG_DIR` wins, else `~/.claude`. */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function projectsDir(): string {
  return join(claudeConfigDir(), 'projects');
}

export interface CostTotals {
  /** Number of priced assistant turns. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface SessionCost extends CostTotals {
  sessionId: string;
  /** Encoded project directory name, e.g. `C--Users-admin-Desktop-Claude-Code`. */
  project: string;
  /** Epoch ms of the newest priced turn in the session. */
  lastActivity: number;
}

export interface TranscriptCostReport {
  /** Everything inside the scan window. */
  total: CostTotals;
  /** Since local midnight. */
  today: CostTotals;
  /** Rolling 7×24h. */
  last7Days: CostTotals;
  /** Rolling 30×24h. */
  last30Days: CostTotals;
  byModel: Record<string, CostTotals>;
  /** Newest-activity first. */
  sessions: SessionCost[];
  /**
   * Models seen with no entry in the pricing table. Their tokens are counted
   * but priced at $0, so a non-empty list means `costUsd` is an undercount.
   */
  unpricedModels: string[];
  filesScanned: number;
  /** Days of history the scan covered — matches the `windowDays` option. */
  windowDays: number;
}

export interface ScanOptions {
  /**
   * Ignore transcripts whose newest write is older than this many days. Every
   * record in such a file predates the cutoff, so skipping it is exact for the
   * today/7d/30d buckets and only bounds `total`. Default 30.
   */
  windowDays?: number;
  /** Override the projects directory (tests). */
  dir?: string;
  /** Override "now" (tests). */
  now?: number;
}

function emptyTotals(): CostTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
}

interface CallRecord {
  ts: number;
  model: string;
  sessionId: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

function add(into: CostTotals, rec: CallRecord): void {
  into.calls += 1;
  into.inputTokens += rec.inputTokens;
  into.outputTokens += rec.outputTokens;
  into.cacheCreationTokens += rec.cacheCreationTokens;
  into.cacheReadTokens += rec.cacheReadTokens;
  into.costUsd += rec.costUsd;
}

/** Recursively collect `*.jsonl` under `dir`, newest-modified files first. */
function findTranscripts(dir: string, cutoffMs: number): { path: string; project: string }[] {
  const out: { path: string; project: string }[] = [];
  const walk = (current: string, project: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir — a missing projects/ is the normal cold-start case
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, project || entry.name);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          if (statSync(path).mtimeMs >= cutoffMs) out.push({ path, project });
        } catch { /* raced with a delete */ }
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Parse one transcript. `seen` is shared across files: resuming or forking a
 * session copies earlier turns into the new transcript, so the same assistant
 * turn appears in several files and would otherwise be billed twice.
 */
function parseTranscript(
  path: string,
  project: string,
  seen: Set<string>,
  unpriced: Set<string>,
): CallRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    debug('TranscriptCost', `Failed to read ${path}: ${err}`);
    return [];
  }

  const records: CallRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn final line while Claude Code is mid-write
    }
    if (row.type !== 'assistant') continue;

    const usage = row.message?.usage;
    if (!usage) continue;

    // message.id is per assistant turn; requestId distinguishes retries of the
    // same turn. Together they identify one billable call.
    const dedupKey = `${row.message?.id ?? ''}:${row.requestId ?? ''}`;
    if (dedupKey !== ':' && seen.has(dedupKey)) continue;
    if (dedupKey !== ':') seen.add(dedupKey);

    const model: string = row.message?.model ?? 'unknown';
    if (!isPricedModel(model)) unpriced.add(model);

    const ts = Date.parse(row.timestamp);
    if (Number.isNaN(ts)) continue;

    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

    records.push({
      ts,
      model,
      sessionId: row.sessionId ?? '',
      project,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUsd: priceUsdWithCache(model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
      }),
    });
  }
  return records;
}

export function scanTranscriptCosts(opts: ScanOptions = {}): TranscriptCostReport {
  const windowDays = opts.windowDays ?? 30;
  const now = opts.now ?? Date.now();
  const dir = opts.dir ?? projectsDir();

  const dayMs = 86_400_000;
  const windowStart = now - windowDays * dayMs;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();

  const report: TranscriptCostReport = {
    total: emptyTotals(),
    today: emptyTotals(),
    last7Days: emptyTotals(),
    last30Days: emptyTotals(),
    byModel: {},
    sessions: [],
    unpricedModels: [],
    filesScanned: 0,
    windowDays,
  };

  const seen = new Set<string>();
  const unpriced = new Set<string>();
  const bySession = new Map<string, SessionCost>();

  for (const { path, project } of findTranscripts(dir, windowStart)) {
    report.filesScanned += 1;
    for (const rec of parseTranscript(path, project, seen, unpriced)) {
      if (rec.ts < windowStart) continue;

      add(report.total, rec);
      if (rec.ts >= todayStart) add(report.today, rec);
      if (rec.ts >= now - 7 * dayMs) add(report.last7Days, rec);
      if (rec.ts >= now - 30 * dayMs) add(report.last30Days, rec);

      const model = (report.byModel[rec.model] ??= emptyTotals());
      add(model, rec);

      let session = bySession.get(rec.sessionId);
      if (!session) {
        session = { ...emptyTotals(), sessionId: rec.sessionId, project: rec.project, lastActivity: 0 };
        bySession.set(rec.sessionId, session);
      }
      add(session, rec);
      if (rec.ts > session.lastActivity) session.lastActivity = rec.ts;
    }
  }

  report.sessions = [...bySession.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  report.unpricedModels = [...unpriced].sort();

  debug(
    'TranscriptCost',
    `${report.filesScanned} files, ${report.total.calls} calls, $${report.total.costUsd.toFixed(4)} total`,
  );
  return report;
}

/**
 * Share of input tokens served from cache, 0–1. The headline number for the
 * cache-efficiency view: a low ratio in a long session means the prompt prefix
 * is being invalidated and cost is higher than it needs to be.
 */
export function cacheHitRatio(totals: CostTotals): number | null {
  const denom = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  if (denom <= 0) return null;
  return totals.cacheReadTokens / denom;
}

/** How many per-model entries ride the wire. The encoder LCD shows at most 3. */
const MAX_WIRE_MODELS = 5;

/** Narrow a full report to the wire shape — the per-session detail stays local. */
export function toCostSummary(report: TranscriptCostReport, scannedAt: number): TranscriptCostSummary {
  const byModel = Object.entries(report.byModel)
    .map(([model, totals]) => ({ model, costUsd: totals.costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, MAX_WIRE_MODELS);

  const settings = loadCostSettings();

  return {
    today: report.today,
    last7Days: report.last7Days,
    last30Days: report.last30Days,
    cacheHitRatio: cacheHitRatio(report.last30Days) ?? undefined,
    byModel,
    unpricedModels: report.unpricedModels.length > 0 ? report.unpricedModels : undefined,
    dailyBudgetUsd: settings.dailyBudgetUsd ?? undefined,
    budgetState: budgetStateFor(report.today.costUsd, settings),
    scannedAt,
  };
}

// ===== Throttled cache =====
//
// The scan re-reads every in-window transcript, which is cheap for a handful of
// sessions and not cheap for a year of them. The usage tick fires every 5s, so
// the scan is throttled well below that and the cached summary is reused.

const DEFAULT_REFRESH_MS = 120_000;

let cachedSummary: TranscriptCostSummary | null = null;
let lastScanAt = 0;
let scanning = false;

/** Last computed summary, or null before the first successful scan. */
export function getCachedCostSummary(): TranscriptCostSummary | null {
  return cachedSummary;
}

/** Drop the cache so the next refresh rescans (system wake, tests). */
export function resetCostCache(): void {
  cachedSummary = null;
  lastScanAt = 0;
}

/**
 * Rescan if the cache is older than `minIntervalMs`, otherwise return it
 * unchanged. Never throws: a failed scan keeps the previous summary, since a
 * stale dollar figure beats a blank dial.
 */
export function refreshCostSummary(minIntervalMs = DEFAULT_REFRESH_MS): TranscriptCostSummary | null {
  const now = Date.now();
  if (scanning) return cachedSummary;
  if (cachedSummary && now - lastScanAt < minIntervalMs) return cachedSummary;

  scanning = true;
  try {
    cachedSummary = toCostSummary(scanTranscriptCosts({ windowDays: 30, now }), now);
    lastScanAt = now;
  } catch (err) {
    debug('TranscriptCost', `Scan failed, keeping previous summary: ${err}`);
    lastScanAt = now; // don't retry-storm on a persistent failure
  } finally {
    scanning = false;
  }
  return cachedSummary;
}
