/**
 * User-tunable settings read from ~/.agentdeck/settings.json.
 *
 * Covers the `cost.*` spend budget and the `notifications.*` attention toast.
 * Both are read on a short cache so an edit takes effect without a restart, and
 * both fall back to safe defaults when the file is missing or unparseable —
 * a broken settings file must never stop the daemon.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Fraction of the budget at which the view turns amber. */
export const DEFAULT_WARN_AT_PERCENT = 80;

// ===== Daily spend budget =====
//
// Unset means no budget, which is the default: a budget nobody asked for would
// paint the encoder red on a normal working day. The figure it is compared
// against is an *estimate* from local transcripts at list prices (see
// bridge/src/transcript-cost.ts) — a self-imposed tripwire, not a billing
// control. Nothing is blocked when it trips.

export interface CostSettings {
  /** Daily budget in USD, or null when the user has not set one. */
  dailyBudgetUsd: number | null;
  /** Percentage of the budget that counts as "warn" (1–100). */
  warnAtPercent: number;
}

let cached: { at: number; value: CostSettings } | null = null;
const CACHE_TTL_MS = 30_000;

function settingsPath(): string {
  const dir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
  return join(dir, 'settings.json');
}

/** Positive, finite numbers only — a 0 or negative budget is treated as unset. */
function positiveNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function loadCostSettings(): CostSettings {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let dailyBudgetUsd: number | null = null;
  let warnAtPercent = DEFAULT_WARN_AT_PERCENT;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
    const cost = (raw.cost ?? {}) as Record<string, unknown>;
    dailyBudgetUsd = positiveNumber(cost.dailyBudgetUsd);
    const warn = positiveNumber(cost.warnAtPercent);
    if (warn !== null && warn <= 100) warnAtPercent = warn;
  } catch {
    // No settings file, or unreadable — no budget is the correct default.
  }

  const value: CostSettings = { dailyBudgetUsd, warnAtPercent };
  cached = { at: Date.now(), value };
  return value;
}

/** Drop the cache so the next load re-reads the file (tests, settings edits). */
export function resetCostSettingsCache(): void {
  cached = null;
}

// ===== Desktop notifications =====

export interface NotificationSettings {
  /** Raise a desktop notification when a session starts waiting on you. */
  attention: boolean;
  /** Minimum gap between notices for the same session. */
  repeatWindowMs: number;
}

/** Long enough that answering and re-prompting doesn't double-notify. */
export const DEFAULT_NOTIFY_REPEAT_WINDOW_MS = 60_000;

let notifyCached: { at: number; value: NotificationSettings } | null = null;

/**
 * Source: ~/.agentdeck/settings.json → `notifications.{attention,repeatWindowMs}`.
 *
 * Defaults to on: "tell me when the agent needs me" is the point of the
 * feature, and it only fires on the AWAITING states, never on ordinary turn
 * ends. Set `notifications.attention` to false to silence it.
 */
export function loadNotificationSettings(): NotificationSettings {
  if (notifyCached && Date.now() - notifyCached.at < CACHE_TTL_MS) return notifyCached.value;

  let attention = true;
  let repeatWindowMs = DEFAULT_NOTIFY_REPEAT_WINDOW_MS;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
    const n = (raw.notifications ?? {}) as Record<string, unknown>;
    if (typeof n.attention === 'boolean') attention = n.attention;
    const window = positiveNumber(n.repeatWindowMs);
    if (window !== null) repeatWindowMs = window;
  } catch {
    // No settings file — the defaults above are correct.
  }

  const value: NotificationSettings = { attention, repeatWindowMs };
  notifyCached = { at: Date.now(), value };
  return value;
}

export function resetNotificationSettingsCache(): void {
  notifyCached = null;
}

// ===== Deck layout =====

export interface DeckSettings {
  /**
   * Keep a session on the key it first appeared on for its whole lifetime,
   * leaving a gap when it ends, instead of packing sessions by list order.
   */
  pinnedSlots: boolean;
}

let deckCached: { at: number; value: DeckSettings } | null = null;

/**
 * Source: ~/.agentdeck/settings.json → `deck.pinnedSlots`.
 *
 * Off by default: packing is denser, and silently rearranging an existing
 * user's keypad is the kind of change that has to be asked for.
 */
export function loadDeckSettings(): DeckSettings {
  if (deckCached && Date.now() - deckCached.at < CACHE_TTL_MS) return deckCached.value;

  let pinnedSlots = false;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
    const deck = (raw.deck ?? {}) as Record<string, unknown>;
    if (typeof deck.pinnedSlots === 'boolean') pinnedSlots = deck.pinnedSlots;
  } catch {
    // No settings file — packed is the correct default.
  }

  const value: DeckSettings = { pinnedSlots };
  deckCached = { at: Date.now(), value };
  return value;
}

export function resetDeckSettingsCache(): void {
  deckCached = null;
}

export type BudgetState = 'ok' | 'warn' | 'over';

/** Classify today's spend against the budget. Null budget ⇒ no state at all. */
export function budgetStateFor(
  spentUsd: number,
  settings: CostSettings,
): BudgetState | undefined {
  const budget = settings.dailyBudgetUsd;
  if (budget === null) return undefined;
  if (spentUsd >= budget) return 'over';
  if (spentUsd >= budget * (settings.warnAtPercent / 100)) return 'warn';
  return 'ok';
}
