/**
 * Paint the OFFLINE banner across a set of encoders.
 *
 * The banner is one 800px design split into four 200px slices, so it only reads
 * as a single strip if each encoder draws the slice for the column it actually
 * occupies. Every dial used to pass a constant matching its default slot, which
 * meant moving a dial — putting the effort dial on E1, say — printed one slice
 * twice and dropped another, leaving the strip looking corrupted.
 */
import { renderOfflineTouchStrip } from './renderers/session-slot-renderer.js';
import { offlineSliceFor } from './encoder-registry.js';
import { paintDialCanvas } from './dial-paint.js';

export function paintOfflineBanner(ids: readonly string[]): void {
  // Through the same memo as every other paint: a direct write here would leave
  // the memo holding whatever was on screen before the daemon dropped, and the
  // first repaint after it came back would be skipped as "unchanged".
  for (const id of ids) {
    paintDialCanvas([id], renderOfflineTouchStrip(offlineSliceFor(id)));
  }
}
