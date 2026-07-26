/**
 * SVG pixmap for the reasoning-effort dial (200x100 encoder LCD).
 *
 * Follows the shared encoder grammar: 14px bold header, value centred, 2px
 * accent bar at y=90.
 */
const W = 200;
const H = 100;

/** Levels low → max, ordered so the fill bar reads as "how hard it thinks". */
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const LEVEL_COLOR: Record<string, string> = {
  low: '#60a5fa',
  medium: '#34d399',
  high: '#fbbf24',
  xhigh: '#fb923c',
  max: '#f87171',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

function accentBar(color: string, fillRatio = 1): string {
  const barW = Math.max(2, Math.round(180 * fillRatio));
  return `<rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${barW}" height="2" rx="1" fill="${color}" opacity="0.4"/>`;
}

export interface EffortDialData {
  effortLevel?: string;
  modelName?: string;
  /** Focused session is idle — rotation will actually do something. */
  idle: boolean;
  /** A nudge has been sent and no commit/cancel yet. */
  adjusting: boolean;
}

export function renderEffortDial(data: EffortDialData): string {
  const level = data.effortLevel?.toLowerCase();
  const idx = level ? LEVELS.indexOf(level as typeof LEVELS[number]) : -1;
  // Unknown levels (a model with its own vocabulary) still render their name;
  // only the fill bar needs a position, so it falls back to empty.
  const ratio = idx >= 0 ? (idx + 1) / LEVELS.length : 0;
  const color = (level && LEVEL_COLOR[level]) || '#94a3b8';

  const header = data.adjusting ? 'EFFORT · ADJUSTING' : 'EFFORT';
  const value = level ? level.toUpperCase() : '—';

  // The dial is inert mid-turn, so say why rather than looking broken.
  const hint = data.adjusting
    ? 'push to confirm · tap to cancel'
    : data.idle
      ? (data.modelName ? esc(data.modelName.replace(/^claude-/, '')) : 'rotate to adjust')
      : 'busy — idle to adjust';

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">${header}</text>
    <text x="100" y="54" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="${data.idle ? color : '#475569'}">${esc(value)}</text>
    <text x="100" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#64748b">${hint}</text>
    ${accentBar(color, ratio)}
  `);
}
