/**
 * The AWAITING option strip — scrolling, and what each encoder's slice shows.
 *
 * The strip only reads as one list if the four 200px windows line up, and the
 * cursor is useless if it can scroll off the panel.
 */
import { describe, expect, it } from 'vitest';
import { VISIBLE_ROWS, renderOptionStrip, scrollTopFor } from '../renderers/option-strip-renderer.js';

describe('scrollTopFor', () => {
  it('does not scroll a list that already fits', () => {
    for (let cursor = 0; cursor < VISIBLE_ROWS; cursor++) {
      expect(scrollTopFor(cursor, VISIBLE_ROWS)).toBe(0);
    }
  });

  it('keeps the cursor on screen for every position in a long list', () => {
    const total = 12;
    for (let cursor = 0; cursor < total; cursor++) {
      const top = scrollTopFor(cursor, total);
      expect(cursor, `cursor ${cursor} above the window`).toBeGreaterThanOrEqual(top);
      expect(cursor, `cursor ${cursor} below the window`).toBeLessThan(top + VISIBLE_ROWS);
    }
  });

  it('never scrolls past the end, which would show blank rows', () => {
    const total = 7;
    expect(scrollTopFor(total - 1, total)).toBe(total - VISIBLE_ROWS);
  });
});

describe('renderOptionStrip', () => {
  const view = {
    question: 'Allow Edit?',
    labels: ['Yes', 'No, tell Claude what to do differently'],
    cursor: 1,
    answerable: true,
  };

  it('emits a 200px slice per encoder, offset to its column', () => {
    for (let slice = 0; slice < 4; slice++) {
      const svg = renderOptionStrip(slice, view);
      expect(svg).toContain('width="200"');
      expect(svg).toContain(`translate(${-slice * 200} 0)`);
    }
  });

  it('carries the full option text, which is the reason this exists', () => {
    // A key wraps to two lines of ~13 characters and truncates the rest.
    const svg = renderOptionStrip(2, view);
    expect(svg).toContain('No, tell Claude what to do differently');
  });

  it('shows the position in the list so a long roll is navigable', () => {
    expect(renderOptionStrip(0, view)).toContain('2/2');
  });

  it('gives the question the full width instead of one encoder', () => {
    // Confined to E1's 200px it clipped at ~24 characters, and "Do you want to
    // overwrit…" does not say what is being approved.
    const long = 'Do you want to overwrite test.txt in the AgentDeck project?';
    expect(renderOptionStrip(0, { ...view, question: long })).toContain(long);
  });

  it('falls back to a prompt when the agent supplied no question', () => {
    expect(renderOptionStrip(0, { ...view, question: undefined })).toContain('選択してください');
  });

  it('says where to answer when the session cannot be answered from here', () => {
    const svg = renderOptionStrip(0, { ...view, answerable: false });
    expect(svg).toContain('ターミナルで回答');
    expect(svg).not.toContain('Rotate · Press');
  });

  it('escapes markup in an option label rather than breaking the SVG', () => {
    // A malformed document renders as a blank LCD, which reads as a dead dial.
    const svg = renderOptionStrip(1, { ...view, labels: ['<script>&"'], cursor: 0 });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});
