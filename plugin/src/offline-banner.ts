/**
 * Paint the OFFLINE banner across a set of encoders.
 *
 * The banner is one 800px design split into four 200px slices, so it only reads
 * as a single strip if each encoder draws the slice for the column it actually
 * occupies. Every dial used to pass a constant matching its default slot, which
 * meant moving a dial — putting the effort dial on E1, say — printed one slice
 * twice and dropped another, leaving the strip looking corrupted.
 */
import streamDeck from '@elgato/streamdeck';
import { svgToDataUrl } from './renderers/button-renderer.js';
import { renderOfflineTouchStrip } from './renderers/session-slot-renderer.js';
import { offlineSliceFor } from './encoder-registry.js';

export function paintOfflineBanner(ids: readonly string[]): void {
  for (const id of ids) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (!dial) continue;
    void dial.setFeedback({
      canvas: svgToDataUrl(renderOfflineTouchStrip(offlineSliceFor(id))),
    }).catch(() => {});
  }
}
