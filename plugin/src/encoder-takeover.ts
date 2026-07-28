/**
 * AWAITING encoder takeover — E1–E4 become one option list while the agent
 * holds for an answer, and go back to being themselves afterwards.
 *
 * Every dial keeps its own behaviour untouched; each one just asks `isActive()`
 * before doing anything, so adding a dial costs one line rather than a rewrite.
 * A previous version of this feature was retired in the Phase 2 redesign; it
 * assembled the encoders in registration order (utility → option → usage),
 * which only matched the physical order while every dial sat in its default
 * slot. This one takes the column from each action's own coordinates.
 */
import { type PromptOption, type SessionInfo, type State } from '@agentdeck/shared';
import { encoderRegistry, offlineSliceFor } from './encoder-registry.js';
import { paintDialCanvas, forgetDialCanvas } from './dial-paint.js';
import { renderOptionStrip } from './renderers/option-strip-renderer.js';
import { EncoderTakeoverState } from './encoder-takeover-state.js';
import { dlog, dinfo } from './log.js';

const state = new EncoderTakeoverState();

type SelectSender = (optionIndex: number) => void;
let sendSelect: SelectSender | null = null;
/** Repaints every dial with its own content — used when handing the LCDs back. */
let restoreDials: (() => void) | null = null;

export function initEncoderTakeover(opts: {
  selectOption: SelectSender;
  restoreDials: () => void;
}): void {
  sendSelect = opts.selectOption;
  restoreDials = opts.restoreDials;
}

/** Every encoder currently placed, whatever action it carries. */
function allEncoderIds(): string[] {
  return [
    ...encoderRegistry.utilityIds,
    ...encoderRegistry.optionIds,
    ...encoderRegistry.usageIds,
    ...encoderRegistry.launcherIds,
    ...encoderRegistry.effortIds,
    ...encoderRegistry.sessionNavIds,
    ...encoderRegistry.agentIds,
  ];
}

export function isTakeoverActive(): boolean {
  return state.isActive();
}

/**
 * Feed the focused session's snapshot — the same one the keypad detail view
 * renders from, which is what keeps the two surfaces in agreement.
 */
export function syncEncoderTakeover(input: {
  sessionId?: string;
  state?: State;
  options: PromptOption[];
  question?: string;
  session?: SessionInfo;
}): void {
  const flipped = state.sync(input);

  if (state.isActive()) {
    if (flipped) {
      dinfo('Takeover', `enter — ${input.options.length} option(s), answerable=${state.isAnswerable()}`);
    }
    paint();
    return;
  }

  if (flipped) {
    dinfo('Takeover', 'exit — handing the encoders back');
    // The paint memo still holds the option strip, so a dial repainting its
    // own unchanged content would be skipped and the strip would stay up.
    for (const id of allEncoderIds()) forgetDialCanvas(id);
    restoreDials?.();
  }
}

function paint(): void {
  const view = {
    question: state.getQuestion(),
    labels: state.getOptions().map((o) => o.label),
    cursor: state.getCursor(),
    answerable: state.isAnswerable(),
  };
  for (const id of allEncoderIds()) {
    paintDialCanvas([id], renderOptionStrip(offlineSliceFor(id), view));
  }
}

/**
 * Rotation moves the cursor, from any of the four dials.
 *
 * Binding it to one encoder would leave the other three inert with nothing on
 * screen to say which one is live.
 */
export function handleTakeoverRotate(ticks: number): void {
  if (!state.isActive() || !state.isAnswerable()) return;
  state.rotate(ticks);
  dlog('Takeover', `rotate → ${state.getCursor() + 1}/${state.getOptions().length}`);
  paint();
}

/** Press confirms the highlighted option, from any of the four dials. */
export function handleTakeoverPress(): void {
  if (!state.isActive()) return;
  if (!state.isAnswerable()) {
    dlog('Takeover', 'press ignored — session has no response channel');
    return;
  }
  const option = state.current();
  if (!option) return;
  dlog('Takeover', `press → select_option ${state.getCursor()}`);
  sendSelect?.(state.getCursor());
}

/**
 * Drop the takeover without waiting for a state update — the session died, the
 * daemon went away, or the detail view closed. Logs like the ordinary exit
 * does: a silent release and a release that never happened look identical in
 * the log, which is precisely the question worth asking when the strip is
 * still on screen.
 */
export function resetEncoderTakeover(): void {
  if (!state.isActive()) return;
  dinfo('Takeover', 'release — no snapshot is coming to turn it off');
  state.reset();
  for (const id of allEncoderIds()) forgetDialCanvas(id);
  restoreDials?.();
}
