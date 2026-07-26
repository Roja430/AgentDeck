/**
 * Roll state for the agent-control dial (model + permission mode).
 *
 * Split out of the action module for the same reason as `session-dial-state`:
 * action files import `@elgato/streamdeck`, which the test runner cannot load.
 *
 * One flat roll rather than two pages switched by an LCD tap. The multi-mode
 * Utility Dial that tapping used to drive was removed precisely because nobody
 * discovered the tap, and this dial would repeat the mistake — the Launcher's
 * single roll (agents, then "New ·" entries) is the pattern that works here.
 */
import type { ModelCatalogEntry } from '@agentdeck/shared';
import { PermissionMode } from '@agentdeck/shared';

export type AgentDialKind = 'model' | 'mode';

export interface AgentDialEntry {
  kind: AgentDialKind;
  /** Shown on the LCD. */
  label: string;
  /** `/model <value>` for a model; the target PermissionMode for a mode. */
  value: string;
}

/**
 * Modes offered, in Claude Code's own cycling order.
 *
 * `dontAsk` and `bypassPermissions` are deliberately absent: both hand the
 * agent blanket approval, and a dial is too easy to nudge past a detent for
 * that to be a one-flick decision. They stay reachable from the terminal.
 */
export const OFFERED_MODES: { label: string; value: string }[] = [
  { label: 'Manual', value: PermissionMode.DEFAULT },
  { label: 'Accept Edits', value: PermissionMode.ACCEPT_EDITS },
  { label: 'Plan', value: PermissionMode.PLAN },
];

/** How many `switch_mode` nudges to try before giving up on reaching a mode. */
export const MAX_MODE_STEPS = OFFERED_MODES.length + 2;

/**
 * Models offered when no catalog has arrived.
 *
 * `modelCatalog` only ever comes from the OpenClaw adapter — Claude Code emits
 * nothing of the sort, so for a Claude session the catalog stays empty forever
 * and a catalog-only dial would offer no models at all. `/model` accepts these
 * aliases directly ("an alias for the latest model … or a model's full name"),
 * which is enough to switch tiers from the deck.
 */
export const FALLBACK_MODELS: { key: string; name: string }[] = [
  { key: 'default', name: 'Default' },
  { key: 'haiku', name: 'Haiku' },
  { key: 'sonnet', name: 'Sonnet' },
  { key: 'opus', name: 'Opus' },
  { key: 'fable', name: 'Fable' },
];

/**
 * The roll: models first, then modes.
 *
 * Unavailable models are dropped — the catalog marks models the account cannot
 * currently reach, and offering one produces a rejection the user has to read
 * off a 200px LCD to understand.
 */
export function buildAgentEntries(catalog: ModelCatalogEntry[] = []): AgentDialEntry[] {
  const usable = catalog.filter((m) => m.available !== false);
  const models: AgentDialEntry[] = usable.length > 0
    ? usable.map((m) => ({ kind: 'model' as const, label: m.name || m.key, value: m.key }))
    : FALLBACK_MODELS.map((m) => ({ kind: 'model' as const, label: m.name, value: m.key }));
  const modes: AgentDialEntry[] = OFFERED_MODES.map((m) => ({
    kind: 'mode' as const,
    label: m.label,
    value: m.value,
  }));
  return [...models, ...modes];
}

export class AgentDialState {
  // Populated up front. The roll never depends on an event arriving: the modes
  // are always offerable, and a Claude session never sends a catalog at all —
  // waiting for one left the dial reading "No session" forever.
  private entries: AgentDialEntry[] = buildAgentEntries([]);
  private cursor = 0;
  private activeModel: string | undefined;
  private activeMode: string | undefined;

  getEntries(): AgentDialEntry[] { return this.entries; }
  getCursor(): number { return this.cursor; }
  current(): AgentDialEntry | undefined { return this.entries[this.cursor]; }
  getActiveModel(): string | undefined { return this.activeModel; }
  getActiveMode(): string | undefined { return this.activeMode; }

  /**
   * Adopt a catalog. The cursor holds its *entry* rather than its index, so a
   * catalog arriving mid-roll does not move the selection under the user.
   */
  setCatalog(catalog: ModelCatalogEntry[]): void {
    const held = this.current();
    this.entries = buildAgentEntries(catalog);
    if (held) {
      const i = this.entries.findIndex((e) => e.kind === held.kind && e.value === held.value);
      if (i >= 0) {
        this.cursor = i;
        return;
      }
    }
    if (this.cursor >= this.entries.length) this.cursor = Math.max(0, this.entries.length - 1);
  }

  /** What the agent reports right now — drives the "active" marker on the LCD. */
  setActive(model: string | undefined, mode: string | undefined): void {
    this.activeModel = model;
    this.activeMode = mode;
  }

  rotate(ticks: number): void {
    if (this.entries.length === 0) return;
    const dir = ticks >= 0 ? 1 : -1;
    this.cursor = (this.cursor + dir + this.entries.length) % this.entries.length;
  }

  /** True when the cursor sits on what is already in effect. */
  isCurrentActive(): boolean {
    const entry = this.current();
    if (!entry) return false;
    return entry.kind === 'model'
      ? isSameModel(entry.value, this.activeModel)
      : entry.value === this.activeMode;
  }

  reset(): void {
    this.entries = buildAgentEntries([]);
    this.cursor = 0;
    this.activeModel = undefined;
    this.activeMode = undefined;
  }
}

/**
 * The catalog carries keys (`sonnet`), the agent reports display names
 * (`Sonnet 5`), and neither side promises the other's spelling — so compare
 * loosely rather than showing nothing as active.
 */
export function isSameModel(key: string, reported: string | undefined): boolean {
  if (!reported) return false;
  const a = key.toLowerCase();
  const b = reported.toLowerCase();
  return a === b || b.startsWith(a) || b.includes(a);
}
