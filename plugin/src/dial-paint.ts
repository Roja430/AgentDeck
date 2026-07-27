/**
 * Write a canvas to a set of encoder LCDs, skipping writes that change nothing.
 *
 * The usage dials repaint on every `usage_update`, which the daemon broadcasts
 * roughly every four seconds whether or not anything moved — measured at 5
 * events per 20s with sessions running and with none. Each repaint re-uploads a
 * full 200×100 image to the panel, so an unchanged gauge was still being redrawn
 * about twelve times a minute.
 *
 * Keyed by action id rather than by dial module: two encoders showing the same
 * action can be told apart, and an id that disappears takes its entry with it.
 */
import streamDeck from '@elgato/streamdeck';
import { svgToDataUrl } from './renderers/button-renderer.js';

const lastPainted = new Map<string, string>();

/** Paint `svg` on each encoder, skipping any already showing it. */
export function paintDialCanvas(ids: readonly string[], svg: string): void {
  let encoded: string | null = null;
  for (const id of ids) {
    if (lastPainted.get(id) === svg) continue;
    const dial = streamDeck.actions.getActionById(id) as any;
    if (!dial) continue;
    encoded ??= svgToDataUrl(svg);
    lastPainted.set(id, svg);
    void dial.setFeedback({ canvas: encoded }).catch(() => {});
  }
}

/**
 * Drop an encoder's memo.
 *
 * Call when the action goes away, and whenever something other than
 * `paintDialCanvas` writes to the panel — a stale memo would suppress the very
 * repaint that puts the dial back.
 */
export function forgetDialCanvas(id: string): void {
  lastPainted.delete(id);
}
