/**
 * Roll state for the agent-control dial (model + permission mode).
 *
 * Split out of the action module for the same reason as `session-dial-state`:
 * action files import `@elgato/streamdeck`, which the test runner cannot load.
 *
 * Two pages — models and modes — swapped by tapping the LCD, each keeping its
 * own cursor so switching back lands where you left off. A single flat roll was
 * tried first and read as one undifferentiated list of unrelated things.
 *
 * The tap is the one interaction here with no visual affordance, so the page
 * name is rendered as a heading rather than left implicit.
 *
 * Labels are Japanese, matching the deck's owner. They are hardcoded rather
 * than localised: the plugin renderers have no i18n layer, and inventing one
 * for six strings would be the larger change. This needs revisiting before the
 * dial goes anywhere but this fork.
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
  { label: '手動', value: PermissionMode.DEFAULT },
  { label: '編集を許可', value: PermissionMode.ACCEPT_EDITS },
  { label: '計画', value: PermissionMode.PLAN },
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
  { key: 'default', name: '既定' },
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
export function buildModelEntries(catalog: ModelCatalogEntry[] = []): AgentDialEntry[] {
  const usable = catalog.filter((m) => m.available !== false);
  return usable.length > 0
    ? usable.map((m) => ({ kind: 'model' as const, label: m.name || m.key, value: m.key }))
    : FALLBACK_MODELS.map((m) => ({ kind: 'model' as const, label: m.name, value: m.key }));
}

export function buildModeEntries(): AgentDialEntry[] {
  return OFFERED_MODES.map((m) => ({ kind: 'mode' as const, label: m.label, value: m.value }));
}

export class AgentDialState {
  // Populated up front. The pages never depend on an event arriving: the modes
  // are always offerable, and a Claude session never sends a catalog at all —
  // waiting for one left the dial reading "No session" forever.
  private models: AgentDialEntry[] = buildModelEntries([]);
  private readonly modes: AgentDialEntry[] = buildModeEntries();
  private page: AgentDialKind = 'model';
  /** One cursor per page, so switching back lands where you left off. */
  private cursors: Record<AgentDialKind, number> = { model: 0, mode: 0 };
  private activeModel: string | undefined;
  private activeMode: string | undefined;

  getPage(): AgentDialKind { return this.page; }
  getEntries(): AgentDialEntry[] { return this.page === 'model' ? this.models : this.modes; }
  getCursor(): number { return this.cursors[this.page]; }
  current(): AgentDialEntry | undefined { return this.getEntries()[this.getCursor()]; }
  getActiveModel(): string | undefined { return this.activeModel; }
  getActiveMode(): string | undefined { return this.activeMode; }

  /** Tapping the LCD swaps pages. */
  togglePage(): AgentDialKind {
    this.page = this.page === 'model' ? 'mode' : 'model';
    return this.page;
  }

  /**
   * Adopt a catalog. The cursor holds its *entry* rather than its index, so a
   * catalog arriving mid-roll does not move the selection under the user.
   */
  setCatalog(catalog: ModelCatalogEntry[]): void {
    const held = this.models[this.cursors.model];
    this.models = buildModelEntries(catalog);
    if (held) {
      const i = this.models.findIndex((e) => e.value === held.value);
      if (i >= 0) {
        this.cursors.model = i;
        return;
      }
    }
    if (this.cursors.model >= this.models.length) {
      this.cursors.model = Math.max(0, this.models.length - 1);
    }
  }

  /** What the agent reports right now — drives the "active" marker on the LCD. */
  setActive(model: string | undefined, mode: string | undefined): void {
    this.activeModel = model;
    this.activeMode = mode;
  }

  rotate(ticks: number): void {
    const entries = this.getEntries();
    if (entries.length === 0) return;
    const dir = ticks >= 0 ? 1 : -1;
    this.cursors[this.page] = (this.getCursor() + dir + entries.length) % entries.length;
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
    this.models = buildModelEntries([]);
    this.page = 'model';
    this.cursors = { model: 0, mode: 0 };
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
