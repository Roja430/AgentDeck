/**
 * Reasoning-effort levels offered by the E1 dial.
 *
 * Claude Code exposes `/effort <level>`, so the dial picks a level locally and
 * applies it in one command. The earlier design drove the `/model` picker with
 * arrow keys because that was where effort lived at the time; it is not where
 * it lives now, and typing into a TUI picker was never robust — it depended on
 * the picker being open, rendering in time, and nothing else consuming the keys.
 *
 * `ultracode` is omitted: the CLI offers it only on models that support it, and
 * a dial cannot tell which is loaded. `auto` is included and is the way back to
 * letting the agent decide.
 */
export const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortLevel = typeof EFFORT_LEVELS[number];

/** Where a reported level sits in the roll, or 0 (`auto`) when unrecognised. */
export function indexOfLevel(level: string | undefined): number {
  if (!level) return 0;
  const i = (EFFORT_LEVELS as readonly string[]).indexOf(level.toLowerCase());
  return i >= 0 ? i : 0;
}

/** Move through the roll, clamped — wrapping from `max` back to `auto` would
 *  make an overshoot silently drop the agent to the cheapest setting. */
export function stepLevel(index: number, ticks: number): number {
  const next = index + (ticks >= 0 ? 1 : -1);
  return Math.max(0, Math.min(EFFORT_LEVELS.length - 1, next));
}
