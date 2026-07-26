import { describe, expect, it } from 'vitest';
import { renderEffortDial } from '../renderers/effort-dial-renderer.js';

describe('renderEffortDial', () => {
  it('shows the level and the model it belongs to', () => {
    const svg = renderEffortDial({ effortLevel: 'high', modelName: 'claude-opus-5', idle: true, adjusting: false });
    expect(svg).toContain('HIGH');
    expect(svg).toContain('opus-5'); // "claude-" trimmed to fit the LCD
  });

  it('says why it is inert while the agent is working', () => {
    const svg = renderEffortDial({ effortLevel: 'high', idle: false, adjusting: false });
    expect(svg).toContain('busy — idle to adjust');
  });

  it('explains the commit/cancel gesture once a nudge is staged', () => {
    const svg = renderEffortDial({ effortLevel: 'high', idle: true, adjusting: true });
    expect(svg).toContain('EFFORT · ADJUSTING');
    expect(svg).toContain('push to confirm · tap to cancel');
  });

  it('renders a placeholder when no level has been observed', () => {
    const svg = renderEffortDial({ idle: true, adjusting: false });
    expect(svg).toContain('—');
  });

  it('still names a level the fill bar has no position for', () => {
    // A model with its own effort vocabulary must not render as blank.
    const svg = renderEffortDial({ effortLevel: 'fast', idle: true, adjusting: false });
    expect(svg).toContain('FAST');
  });

  it('colours the level by intensity', () => {
    expect(renderEffortDial({ effortLevel: 'low', idle: true, adjusting: false })).toContain('#60a5fa');
    expect(renderEffortDial({ effortLevel: 'max', idle: true, adjusting: false })).toContain('#f87171');
  });
});
