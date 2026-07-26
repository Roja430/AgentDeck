/**
 * Cursor state for the session navigation dial.
 *
 * Split out of the action module the same way `session-slot-manager` is split
 * out of `session-slot-button`: the action file imports `@elgato/streamdeck`,
 * which cannot be loaded under the test runner, so the logic worth testing has
 * to live somewhere the runner can reach.
 */
import type { SessionInfo } from '@agentdeck/shared';

export class SessionDialState {
  private sessions: SessionInfo[] = [];
  private focusedId: string | undefined;
  private cursor = 0;

  getSessions(): SessionInfo[] { return this.sessions; }
  getFocusedId(): string | undefined { return this.focusedId; }
  getCursor(): number { return this.cursor; }
  current(): SessionInfo | undefined { return this.sessions[this.cursor]; }

  /**
   * Adopt a new session list. The cursor tracks the focused session by *id*
   * rather than by index — sessions come and go and the list reorders, and
   * re-indexing under the user's hand makes the dial feel random.
   */
  setSessions(list: SessionInfo[], focusedId?: string): void {
    this.sessions = list;
    this.focusedId = focusedId;
    if (focusedId) {
      const i = list.findIndex((s) => s.id === focusedId);
      if (i >= 0) {
        this.cursor = i;
        return;
      }
    }
    if (this.cursor >= list.length) this.cursor = Math.max(0, list.length - 1);
  }

  /** Move by one, wrapping — a short list is faster to reach from either end. */
  rotate(ticks: number): void {
    if (this.sessions.length === 0) return;
    const dir = ticks >= 0 ? 1 : -1;
    this.cursor = (this.cursor + dir + this.sessions.length) % this.sessions.length;
  }

  reset(): void {
    this.sessions = [];
    this.focusedId = undefined;
    this.cursor = 0;
  }
}
