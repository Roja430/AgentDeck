/**
 * Pinned slot assignment — the Codex Micro model, where a key follows one
 * session for its lifetime.
 *
 * The default packed layout derives a session's position from its index in the
 * sorted list, so ending one session shifts every session after it up a key.
 * Your hand learns "the build is on key 3" and then key 3 is something else,
 * which is exactly the moment a STOP press goes to the wrong agent.
 *
 * Pinning trades density for stability: a session claims a position on first
 * sight and keeps it until it ends, and the position it vacates stays empty
 * rather than being back-filled by its neighbours.
 *
 * Positions are global indices, not key numbers. The manager still splits them
 * into pages, so pinning composes with paging instead of replacing it.
 */

export class SlotPinning {
  private pinned = new Map<string, number>();

  /**
   * Reconcile against the current session list.
   *
   * Sessions that ended release their position. Surviving sessions keep theirs.
   * New sessions take the lowest free position — lowest, so the deck fills from
   * the top-left rather than scattering into whatever gaps exist.
   */
  reconcile(sessionIds: string[], capacity: number): void {
    const present = new Set(sessionIds);
    for (const id of [...this.pinned.keys()]) {
      if (!present.has(id)) this.pinned.delete(id);
    }

    // A shrunken capacity (a smaller deck was plugged in) must not leave
    // positions stranded past the end.
    for (const [id, position] of [...this.pinned.entries()]) {
      if (position >= capacity) this.pinned.delete(id);
    }

    const taken = new Set(this.pinned.values());
    for (const id of sessionIds) {
      if (this.pinned.has(id)) continue;
      let position = 0;
      while (taken.has(position)) position += 1;
      if (position >= capacity) break; // out of room; the rest stay unplaced
      this.pinned.set(id, position);
      taken.add(position);
    }
  }

  /** Position of a session, or undefined when it never got one. */
  positionOf(sessionId: string): number | undefined {
    return this.pinned.get(sessionId);
  }

  /** Session holding a position, or undefined when the position is free. */
  sessionAt(position: number): string | undefined {
    for (const [id, p] of this.pinned) {
      if (p === position) return id;
    }
    return undefined;
  }

  /**
   * One past the highest occupied position — how many pages the deck needs.
   * A gap left by an ended session still counts, because the gap is the point.
   */
  occupiedExtent(): number {
    let max = -1;
    for (const p of this.pinned.values()) {
      if (p > max) max = p;
    }
    return max + 1;
  }

  /** Number of sessions currently holding a position. */
  size(): number {
    return this.pinned.size;
  }

  clear(): void {
    this.pinned.clear();
  }
}
