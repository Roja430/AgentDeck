/**
 * Usage data types and shared formatting helpers.
 * Used by the dedicated Usage Dial (E3) renderer.
 */
import type { CodexRateLimits, TranscriptCostSummary } from '@agentdeck/shared';

export interface UsageModeData {
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  sessionDurationSec?: number;
  extraUsageEnabled?: boolean;
  extraUsageUtilization?: number;
  extraUsageMonthlyLimit?: number;
  extraUsageUsedCredits?: number;
  subscriptions?: { name: string; until?: string }[];
  // True when upstream daemon couldn't produce a live usage fetch (App Store
  // sandbox without a CLI relay, OAuth missing, etc.). Plugin treats stale the
  // same as "no data" and renders the disconnected placeholder — a stale
  // number on the encoder LCD reads as current.
  usageStale?: boolean;
  // Codex rolling-window quota (primary ≈ 5h, secondary ≈ 7d). Rides alongside
  // the Claude 5h/7d fields so the SD+ Codex usage encoder (E3) can render.
  codexRateLimits?: CodexRateLimits;
  // Dollar cost derived from local Claude Code transcripts at API list prices.
  // Feeds the COST and CACHE views on the Claude usage encoder (E2).
  transcriptCost?: TranscriptCostSummary;
}

let sharedData: UsageModeData = {};
let onRefreshRequest: (() => void) | null = null;

/** Update shared usage data (called from plugin.ts on usage_update). */
export function updateUsageModeData(data: UsageModeData): void {
  sharedData = { ...sharedData, ...data };
}

/** Get current shared usage data snapshot. */
export function getUsageModeData(): UsageModeData {
  return sharedData;
}

/** Set callback for refresh request (query_usage). */
export function setUsageRefreshCallback(cb: () => void): void {
  onRefreshRequest = cb;
}

/** Fire refresh request. */
export function fireUsageRefresh(): void {
  onRefreshRequest?.();
}


export function formatResetTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff <= 0) return 'now';
    const totalH = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (totalH >= 24) {
      const days = Math.floor(totalH / 24);
      const remainH = totalH % 24;
      return remainH > 0 ? `${days}d${remainH}h` : `${days}d`;
    }
    return totalH > 0 ? `${totalH}h${m}m` : `${m}m`;
  } catch { return ''; }
}

export function formatTokens(n?: number): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── SD+ usage-encoder data builders (Phase 2) ──────────────────────────────
// Map the shared usage snapshot onto the 200×100 dual-tank encoder renderer.

import type { UsageEncoderData } from '../renderers/usage-gauge.js';

/**
 * Build the Claude usage encoder (E2) from the shared snapshot.
 * @param hasReceivedData false before the first usage_update → "Waiting…".
 */
export function buildClaudeUsageEncoder(data: UsageModeData, hasReceivedData: boolean): UsageEncoderData {
  const stale = data.usageStale === true;
  const fiveKnown = !stale && data.fiveHourPercent != null;
  const sevenKnown = !stale && data.sevenDayPercent != null;
  let note: string | undefined;
  if (!hasReceivedData) note = 'Waiting…';
  else if (!fiveKnown && !sevenKnown) note = 'No usage data';
  return {
    agent: 'claude',
    title: 'CLAUDE',
    fiveHour: { label: '5H', usedPercent: data.fiveHourPercent ?? 0, resetsAt: data.fiveHourResetsAt, known: fiveKnown },
    sevenDay: { label: '7D', usedPercent: data.sevenDayPercent ?? 0, resetsAt: data.sevenDayResetsAt, known: sevenKnown },
    note,
  };
}

/**
 * Build the Codex usage encoder (E3) from the shared snapshot. Codex has no
 * rate limits unless the daemon reports `codexRateLimits` (primary ≈ 5h,
 * secondary ≈ 7d) — fall back to a muted note when absent. Credit-based plans
 * (`limit_id`/`credits`, null windows) surface the balance in the note instead.
 * @param hasReceivedData false before the first usage_update → "Waiting…".
 */
export function buildCodexUsageEncoder(data: UsageModeData, hasReceivedData: boolean): UsageEncoderData {
  // NB: Codex rate limits come from local rollout files, independent of the
  // Claude-API `usageStale` flag — so we do NOT blank Codex on global staleness
  // (that wrongly hid Codex whenever no Claude fetch ran). Per-window staleness
  // (an expired snapshot) rides `window.stale`, set centrally in buildUsageEvent.
  const cx = data.codexRateLimits;
  const primary = cx?.primary;
  const secondary = cx?.secondary;
  let note: string | undefined;
  if (!hasReceivedData) note = 'Waiting…';
  else if (primary == null && secondary == null) {
    if (cx?.credits || cx?.limitId) {
      const tier = (cx.limitId ?? 'credits').toUpperCase();
      const bal = cx.credits?.unlimited ? '∞' : (cx.credits?.balance ?? '—');
      note = `${tier} · ${bal} credits`;
    } else {
      note = 'No Codex usage';
    }
  }
  return {
    agent: 'codex',
    title: 'CODEX',
    fiveHour: { label: '5H', usedPercent: primary?.usedPercent ?? 0, resetsAt: primary?.resetsAt, known: primary != null, stale: primary?.stale === true },
    sevenDay: { label: '7D', usedPercent: secondary?.usedPercent ?? 0, resetsAt: secondary?.resetsAt, known: secondary != null, stale: secondary?.stale === true },
    note,
  };
}
